/**
 * @log.li/dsh-memory — long-term memory plugin for DeepSeek Harness.
 *
 * ## What it does
 *
 * 1. **Boot injection (hard guarantee).** Contributes a pre-step message that
 *    reads the memory store (MEMORY.md / the catalog + recent log entries) and
 *    delivers it at the start of every session. The block is
 *    rendered as named parts, so a later edit re-sends **only the parts that
 *    changed** instead of the whole snapshot, and nothing at all is injected
 *    while the store stays put (see `lib/injector.js`).
 *
 * 2. **Runtime skill.** Registers the `memory` skill (operator protocol:
 *    remember / recall / consolidate / forget) through `ctx.skills.register()`.
 *    Project-level filesystem skills can still override it.
 *
 * 3. **Model-facing tools.** `memory_search` / `memory_read` / `memory_write`
 *    close the loop that the resident index opens: the catalog is a map, and
 *    the body of any page is fetched on demand. `memory_write` enforces the
 *    store's two-step write (duplicate check + `ifVersion`), keeps the catalog
 *    row in sync and triggers the auto-commit.
 *
 * 4. **Portable CLI.** Ships `dsh-memory` (search / lint / status / init /
 *    pack / unpack) so memory stays usable from a shell and migratable
 *    across machines and agents.
 *
 * 5. **Settings panel.** `enabled` / `memoryDir` / `autoInject` /
 *    `registerSkill` / `registerTools` / `indexBootMode` / `autoMemory` are
 *    editable in the Settings panel and hot-apply. They live in `<dshHome>/memory.json` and
 *    are served to the browser through the plugin's own HTTP route — the
 *    settings wire only serves a hard-coded namespace allowlist, so a plugin
 *    namespace is never remotely writable (see `lib/config-store.js`).
 *
 * The memory store itself is plain markdown + git — the plugin never owns
 * the format, only the workflows around it.
 *
 * ## Config
 *
 * | key | default | meaning |
 * |---|---|---|
 * | `enabled` | `true` | master switch: stops boot injection, skill and tools |
 * | `memoryDir` | `~/.memory` | absolute memory-store path (`~` expanded) |
 * | `bootFiles` | `[MEMORY.md, index.md]` | files injected at boot (persona files are ordinary pages) |
 * | `bootMaxChars` | `6000` | total character budget of the boot block |
 * | `indexBootMode` | `derive` | `derive` = catalog entries inject the `salience: 1` hot subset; `off` = inject the catalog literally |
 * | `autoInject` | `true` | inject the boot block at session start |
 * | `registerSkill` | `true` | register the embedded `memory` skill |
 * | `registerTools` | `true` | register `memory_search` / `memory_read` / `memory_write` |
 * | `autoMemory` | `true` | silent end-of-turn extraction through the `memory_write` engine |
 * | `autoMemoryMaxPerSession` | `2` | how many times one session may auto-extract |
 * | `autoMemoryMinTurnsBetweenRuns` | `3` | minimum turns between two extractions |
 * | `scaffold` | `true` | create the store layout + templates when missing |
 * | `configFile` | `<dshHome>/memory.json` | user-facing config file (Settings panel) |
 *
 * `enabled`, `memoryDir`, `autoInject`, `registerSkill`, `registerTools`,
 * `indexBootMode` and `autoMemory` are editable in the Settings panel and
 * hot-apply. The other keys are composition-time only.
 *
 * v0.8.0 removed the persona-side machinery (soul bootstrap, proactive recall,
 * digest reminders, the two politeness gates) and the activity tracker behind
 * them: this plugin is memory, not a persona.
 *
 * ## Install (this fork)
 *
 * Not published to npm — install into a profile by link:
 *
 * ```json
 * // profile package.json: dependencies key + dsh.profile.bundles entry both use the new name
 * "@log.li/dsh-memory": "link:<本仓库绝对路径>"
 * ```
 *
 * The shipped `cordis.patch.yml` inserts the plugin into the profile itself:
 *
 * ```yaml
 * - insert:
 *     - id: dsh-memory
 *       name: '@log.li/dsh-memory'
 *       inject:
 *         - skills
 *         - agents
 *       config:
 *         memoryDir: '~/.memory'
 * ```
 *
 * @module @log.li/dsh-memory
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { renderBootBlock } from './boot.js'
import { BootInjector } from './injector.js'
import { ensureMemoryScaffold } from './scaffold.js'
import { MemoryConfigStore } from './config-store.js'
import { SettingsSchema } from './schema.js'
import { AutoCommitter } from './autocommit.js'
import { registerMemoryTools } from './tools.js'
import { AutoMemory } from './automemory.js'
import {
  MEMORY_SKILL_NAME,
  MEMORY_SKILL_DESCRIPTION,
  MEMORY_SKILL_WHEN_TO_USE,
  memorySkillContent,
} from './skill.js'

export const name = 'memory'

/** HTTP route serving the user-facing config to the browser Settings panel. */
export const CONFIG_ROUTE_PATH = '/api/memory/config'
/** HTTP route answering "is automemory paused for the session I am in?". */
export const AUTOMEMORY_ROUTE_PATH = '/api/memory/automemory'

export const inject = ['skills', 'agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  memoryDir: z.string().default('~/.memory'),
  bootFiles: z.array(z.string()).default(['MEMORY.md', 'index.md']),
  bootMaxChars: z.number().default(6000),
  // Catalog boot entries render the salience=1 hot subset instead of the
  // (truncated) full catalog; 'off' restores the literal byte-for-byte file.
  indexBootMode: z.union([z.const('off'), z.const('derive')]).default('derive'),
  autoInject: z.boolean().default(true),
  registerSkill: z.boolean().default(true),
  registerTools: z.boolean().default(true),
  scaffold: z.boolean().default(true),
  // Automemory (default ON since v0.8.0): silent end-of-turn extraction through
  // the same engine as `memory_write`, replacing the removed digest reminder.
  autoMemory: z.boolean().default(true),
  autoMemoryProvider: z.union([z.string(), z.const(undefined)]),
  autoMemoryModel: z.union([z.string(), z.const(undefined)]),
  autoMemoryMaxPerSession: z.number().default(2),
  autoMemoryMinTurnsBetweenRuns: z.number().default(3),
  autoMemoryMinTranscriptChars: z.number().default(200),
  autoMemoryMaxPages: z.number().default(3),
  autoMemoryMaxTokens: z.number().default(2000),
  autoMemoryTimeoutMs: z.number().default(60000),
  configFile: z.union([z.string(), z.const(undefined)]),
  // Auto-commit: keep the store's git history current after a quiet period.
  autoCommit: z.boolean().default(true),
  autoCommitQuietSeconds: z.number().default(60),
  autoCommitIntervalSeconds: z.number().default(60),
})

/**
 * Expand `~` to the home directory and resolve to an absolute path.
 * @param {string} dir
 * @returns {string}
 */
export function resolveMemoryDir(dir) {
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return resolve(dir)
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config> | import('./types/index.d.ts').MemoryConfig} config
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const bootMaxChars = Math.max(512, Number(config.bootMaxChars) || 6000)
  const bootFiles = config.bootFiles ?? ['MEMORY.md', 'index.md']
  const scaffoldEnabled = config.scaffold !== false

  // Single user-facing config source: composition defaults + memory.json.
  const store = new MemoryConfigStore({
    path: typeof config.configFile === 'string' && config.configFile.trim().length > 0 ? config.configFile : undefined,
    base: {
      enabled: config.enabled !== false,
      memoryDir: config.memoryDir ?? '~/.memory',
      autoInject: config.autoInject !== false,
      registerSkill: config.registerSkill !== false,
      registerTools: config.registerTools !== false,
      indexBootMode: config.indexBootMode === 'off' ? 'off' : 'derive',
      autoMemory: config.autoMemory !== false,
    },
  })

  /**
   * Structural rule: only root sessions read or write long-term memory.
   * v0.8.0 removed the two activity gates (user-spoke / active-session); this
   * explicit predicate keeps their one useful side effect — subagents, which
   * are ephemeral workers, neither receive the block nor auto-extract.
   */
  const isRootAgent = (agent) => {
    try {
      return ctx.agents.roots().includes(agent)
    } catch {
      // Fail open on purpose: this rule protects against noise (a subagent
      // receiving the block), not against corruption. If the registry cannot
      // answer, losing memory for every session would be the worse failure.
      return true
    }
  }

  let skillDispose
  let scaffoldedDir
  let committer
  let currentMemoryDir = resolveMemoryDir(store.get().memoryDir)

  const disposeSkill = () => {
    if (skillDispose !== undefined) {
      skillDispose()
      skillDispose = undefined
    }
  }

  const disposeCommitter = () => {
    if (committer !== undefined) {
      committer.dispose()
      committer = undefined
    }
  }

  // The boot block is delivered by a pre-step contribution rather than a
  // passive `systemPrompt.context()` provider: that is what allows part-level
  // updates (a snapshot context may only supersede wholesale) and what lets
  // an unchanged store cost nothing. Gates are read live, so the Settings
  // panel's toggles apply to the very next step.
  const injector = new BootInjector({
    getMemoryDir: () => currentMemoryDir,
    getBootOptions: () => ({
      bootFiles,
      bootMaxChars,
      indexBootMode: store.get().indexBootMode === 'off' ? 'off' : 'derive',
    }),
    getGates: () => store.get(),
    isRoot: isRootAgent,
    logger: ctx.logger,
    pluginName: name,
  })

  /** Tools: `memory_search` / `memory_read` / `memory_write`. */
  let toolsHost
  let toolsDispose

  const disposeTools = () => {
    if (toolsDispose !== undefined) {
      toolsDispose()
      toolsDispose = undefined
    }
  }

  /**
   * Commit the store now, for `memory_write` (the polling auto-committer would
   * otherwise wait out its quiet window). Returns a model-facing status word.
   * @returns {string}
   */
  const triggerCommit = () => {
    if (committer === undefined) return 'disabled'
    try {
      return committer.check(true)
    } catch (error) {
      ctx.logger?.warn?.(`memory: commit after write failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  /**
   * Register or drop the three memory tools. Called both from `rebuild()`
   * (config edits) and when `ctx.tools` first appears.
   * @param {boolean} wantTools
   */
  const applyTools = (wantTools) => {
    if (toolsHost === undefined) return
    disposeTools()
    if (wantTools) {
      toolsDispose = registerMemoryTools(toolsHost, {
        getMemoryDir: () => currentMemoryDir,
        triggerCommit,
        logger: ctx.logger,
      })
    }
  }

  /**
   * Automemory pause registry, keyed by session id. The Settings panel cannot
   * know which session it is rendering for, so the route resolves "this
   * session" host-side as the currently active one (the same proxy the two
   * injection gates use).
   */
  const pausedSessions = new Set()
  /** Live automemory instances, addressable by session id. */
  const autoMemoryBySession = new Map()

  /**
   * The session the user is talking to — used **only** to resolve which session
   * the panel's "pause automemory" button applies to (it is not an injection
   * gate). A tiny counter over real user messages replaces the tracker that
   * v0.8.0 removed: the session with the newest real user message wins.
   */
  const lastUserMessageOrder = new Map()
  let userMessageSeq = 0
  ctx.effect(() => {
    const stop = ctx.on('session/event', (subject, event) => {
      if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
      const sessionId = subject?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      lastUserMessageOrder.set(sessionId, (userMessageSeq += 1))
    })
    return () => stop?.()
  }, 'memory.session-activity()')

  const activeSessionId = () => {
    let winner
    let newest = 0
    for (const [sessionId, order] of lastUserMessageOrder) {
      if (!autoMemoryBySession.has(sessionId)) continue
      if (order > newest) {
        newest = order
        winner = sessionId
      }
    }
    return winner
  }

  /**
   * Bring skill registration, tool registration, the scaffold and the
   * auto-committer in line with the current resolved config. Called once at
   * startup, whenever `ctx.tools` becomes available, and on every config-store
   * change.
   */
  const rebuild = () => {
    const resolved = store.get()
    const memoryDir = resolveMemoryDir(resolved.memoryDir)
    const wantSkill = resolved.enabled && resolved.registerSkill
    const wantTools = resolved.enabled && resolved.registerTools !== false

    if (resolved.enabled && scaffoldEnabled && memoryDir !== scaffoldedDir) {
      const created = ensureMemoryScaffold(memoryDir)
      scaffoldedDir = memoryDir
      if (created.length > 0) {
        ctx.logger?.info(`memory: initialized scaffold at ${memoryDir} (${created.length} entries)`)
      }
    }

    // Auto-commit follows the store dir: create on first build, restart
    // when the dir changes. (The first rebuild must create it too — the
    // dir only "changes" on a later config edit.)
    if (committer === undefined || memoryDir !== currentMemoryDir) {
      currentMemoryDir = memoryDir
      disposeCommitter()
      if (resolved.enabled && config.autoCommit !== false) {
        committer = new AutoCommitter(memoryDir, {
          quietSeconds: config.autoCommitQuietSeconds,
          intervalSeconds: config.autoCommitIntervalSeconds,
          logger: ctx.logger,
        })
        committer.start()
      }
    }

    if (wantSkill) {
      disposeSkill()
      skillDispose = ctx.skills.register({
        name: MEMORY_SKILL_NAME,
        description: MEMORY_SKILL_DESCRIPTION,
        whenToUse: MEMORY_SKILL_WHEN_TO_USE,
        content: memorySkillContent(),
        source: '@log.li/dsh-memory',
        resourceBase: { kind: 'directory', path: memoryDir },
      })
    } else {
      disposeSkill()
    }

    applyTools(wantTools)

    ctx.logger?.info(
      `memory: ${resolved.enabled ? `enabled, store at ${memoryDir}` : 'disabled'}`
      + ` (boot ${resolved.enabled && resolved.autoInject ? 'on' : 'off'}, skill ${wantSkill ? 'on' : 'off'}, tools ${wantTools ? 'on' : 'off'})`,
    )
  }

  rebuild()

  // Boot injection: one listener for the whole plugin lifetime; it reads the
  // live config and the live store on every step.
  ctx.effect(() => {
    const stop = ctx.on('agent/pre-step', (event, next) => injector.handle(event, next))
    return () => {
      stop?.()
      injector.dispose()
    }
  }, 'memory.boot-injection()')

  // Automemory: one instance per live ROOT agent (default ON since v0.8.0). It runs
  // at the idle boundary, only for the session the user is talking to, and
  // every failure is contained — an unattended writer must never break a turn.
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      const auto = new AutoMemory(agent, {
        readConfig: () => {
          const resolved = store.get()
          return {
            ...resolved,
            autoMemoryProvider: config.autoMemoryProvider,
            autoMemoryModel: config.autoMemoryModel,
            autoMemoryMaxPerSession: config.autoMemoryMaxPerSession,
            autoMemoryMinTurnsBetweenRuns: config.autoMemoryMinTurnsBetweenRuns,
            autoMemoryMinTranscriptChars: config.autoMemoryMinTranscriptChars,
            autoMemoryMaxPages: config.autoMemoryMaxPages,
            autoMemoryMaxTokens: config.autoMemoryMaxTokens,
            autoMemoryTimeoutMs: config.autoMemoryTimeoutMs,
          }
        },
        getMemoryDir: () => currentMemoryDir,
        isPaused: (sessionId) => pausedSessions.has(sessionId),
        isRoot: isRootAgent,
        logger: ctx.logger,
      })
      const sessionId = agent.session?.id
      if (typeof sessionId === 'string' && sessionId.length > 0) autoMemoryBySession.set(sessionId, auto)
      agent.ctx.effect(() => {
        auto.start()
        return () => {
          auto.dispose()
          if (typeof sessionId === 'string') {
            autoMemoryBySession.delete(sessionId)
            // The counter only exists to resolve the pause button's target;
            // dropping the entry with its session keeps the map bounded.
            lastUserMessageOrder.delete(sessionId)
            pausedSessions.delete(sessionId)
          }
        }
      })
    })
    return () => stopCreated()
  }, 'memory.automemory()')

  // Settings-panel hot edits: any store change re-applies the config.
  ctx.effect(() => {
    const unwatch = store.watch(() => rebuild())
    return () => {
      unwatch()
    }
  }, 'memory.config-watch()')

  // Model-facing memory tools (optional: a deployment without the tool
  // service simply keeps boot injection + the skill).
  ctx.inject(['tools'], (toolsCtx) => {
    toolsHost = toolsCtx
    const resolved = store.get()
    applyTools(resolved.enabled && resolved.registerTools !== false)
    return () => {
      disposeTools()
      toolsHost = undefined
    }
  })

  // Browser config route (optional: headless deployments have no webServer).
  ctx.inject(['webServer'], (webCtx) => {
    const disposeRoute = webCtx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(store.get()))
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = Buffer.concat(chunks).toString('utf8')
            let patch
            try {
              patch = JSON.parse(body)
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'body must be JSON' }))
              return
            }
            const next = store.update(patch)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(next))
            return
          }
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    webCtx.effect(() => disposeRoute, 'memory.config-route()')

    const disposeAutoRoute = webCtx.webServer.register({
      kind: 'exact',
      path: AUTOMEMORY_ROUTE_PATH,
      handler: async (req, res) => {
        const json = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          const sessionId = activeSessionId()
          if (req.method === 'GET') {
            json(200, {
              enabled: store.get().autoMemory === true,
              sessionId: sessionId ?? null,
              paused: sessionId === undefined ? false : pausedSessions.has(sessionId),
            })
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            let patch
            try {
              patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              json(400, { error: 'body must be JSON' })
              return
            }
            if (typeof patch?.paused !== 'boolean') {
              json(400, { error: 'paused must be a boolean' })
              return
            }
            if (sessionId === undefined) {
              json(409, { error: 'no active memory session to pause' })
              return
            }
            if (patch.paused) pausedSessions.add(sessionId)
            else pausedSessions.delete(sessionId)
            json(200, { enabled: store.get().autoMemory === true, sessionId, paused: patch.paused })
            return
          }
          json(405, { error: 'method not allowed' })
        } catch (error) {
          ctx.logger?.warn?.(`memory: automemory route failed: ${error instanceof Error ? error.message : String(error)}`)
          json(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    webCtx.effect(() => disposeAutoRoute, 'memory.automemory-route()')
    ctx.logger?.info(`memory: config route at ${CONFIG_ROUTE_PATH} (store ${store.path})`)
  })

  return () => {
    disposeSkill()
    disposeTools()
    disposeCommitter()
    injector.dispose()
  }
}

// DSH's loader unwraps a package's default export before it starts the
// Cordis plugin. Keep the default export callable for direct consumers, but
// attach the Cordis metadata to that function so injected services and the
// config schema survive the unwrap step.
Object.defineProperties(apply, {
  name: { value: name },
  inject: { value: inject },
  Config: { value: Config },
})

export default apply

export { renderBootBlock, ensureMemoryScaffold, SettingsSchema, MemoryConfigStore }
