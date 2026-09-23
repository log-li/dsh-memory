/**
 * @log.li/dsh-memory — long-term memory plugin for DeepSeek Harness.
 *
 * ## What it does
 *
 * 1. **Boot injection (hard guarantee).** Contributes a pre-step message that
 *    reads the memory store (SOUL.md / MEMORY.md / the catalog + recent log
 *    entries) and delivers it at the start of every session. The block is
 *    rendered as named parts, so a later edit re-sends **only the parts that
 *    changed** instead of the whole snapshot, and nothing at all is injected
 *    while the store stays put (see `lib/injector.js`).
 *
 * 2. **Runtime skill.** Registers the `memory` skill (operator protocol:
 *    bootstrap soul-definition, remember / recall / consolidate / forget)
 *    through `ctx.skills.register()`. Project-level filesystem skills can
 *    still override it.
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
 *    `registerSkill` / `registerTools` / `indexBootMode` are editable in the
 *    Settings panel and hot-apply. They live in `<dshHome>/memory.json` and
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
 * | `bootFiles` | `[SOUL.md, MEMORY.md, index.md]` | files injected at boot |
 * | `bootMaxChars` | `6000` | total character budget of the boot block |
 * | `indexBootMode` | `derive` | `derive` = catalog entries inject the `salience: 1` hot subset; `off` = inject the catalog literally |
 * | `autoInject` | `true` | inject the boot block at session start |
 * | `registerSkill` | `true` | register the embedded `memory` skill |
 * | `registerTools` | `true` | register `memory_search` / `memory_read` / `memory_write` |
 * | `scaffold` | `true` | create the store layout + templates when missing |
 * | `configFile` | `<dshHome>/memory.json` | user-facing config file (Settings panel) |
 *
 * `enabled`, `memoryDir`, `autoInject`, `registerSkill`, `registerTools` and
 * `indexBootMode` are editable in the Settings panel and hot-apply. The other
 * keys are composition-time only.
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
import { DigestGuard } from './digest-guard.js'
import { RecallNudge } from './recall-nudge.js'
import { AutoCommitter } from './autocommit.js'
import { ActivityTracker } from './activity-tracker.js'
import { registerMemoryTools } from './tools.js'
import {
  MEMORY_SKILL_NAME,
  MEMORY_SKILL_DESCRIPTION,
  MEMORY_SKILL_WHEN_TO_USE,
  memorySkillContent,
} from './skill.js'

export const name = 'memory'

/** HTTP route serving the user-facing config to the browser Settings panel. */
export const CONFIG_ROUTE_PATH = '/api/memory/config'

export const inject = ['skills', 'agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  memoryDir: z.string().default('~/.memory'),
  bootFiles: z.array(z.string()).default(['SOUL.md', 'MEMORY.md', 'index.md']),
  bootMaxChars: z.number().default(6000),
  // Catalog boot entries render the salience=1 hot subset instead of the
  // (truncated) full catalog; 'off' restores the literal byte-for-byte file.
  indexBootMode: z.union([z.const('off'), z.const('derive')]).default('derive'),
  autoInject: z.boolean().default(true),
  registerSkill: z.boolean().default(true),
  registerTools: z.boolean().default(true),
  scaffold: z.boolean().default(true),
  configFile: z.union([z.string(), z.const(undefined)]),
  // Gate 1: don't inject until the session's first real user message.
  deferUntilUserSpeaks: z.boolean().default(true),
  // Gate 2: only the currently active session (most recent user message) injects.
  activeSessionOnly: z.boolean().default(true),
  // Digest guard: inject a synthetic reminder when the agent sits idle and
  // the store has not been written for a while, so the end-of-session
  // digest cannot be silently skipped.
  digestNudgeEnabled: z.boolean().default(true),
  digestNudgeAfterMinutes: z.number().default(120),
  digestNudgeCooldownMinutes: z.number().default(180),
  digestNudgeMaxPerSession: z.number().default(2),
  // Recall nudge: when the agent sits idle, invite it to surface a real
  // memory about the user in a first-person voice (the "persona" half —
  // conversational only, never mutates the store). The interval is a random
  // draw inside [minMinutes, maxMinutes] each time, so recalls never feel
  // metronomic.
  recallEnabled: z.boolean().default(true),
  recallIntervalMinMinutes: z.number().default(30),
  recallIntervalMaxMinutes: z.number().default(240),
  recallMaxPerSession: z.number().default(3),
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
  const bootFiles = config.bootFiles ?? ['SOUL.md', 'MEMORY.md', 'index.md']
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
      deferUntilUserSpeaks: config.deferUntilUserSpeaks !== false,
      activeSessionOnly: config.activeSessionOnly !== false,
      recallEnabled: config.recallEnabled !== false,
      recallIntervalMinMinutes: config.recallIntervalMinMinutes ?? 30,
      recallIntervalMaxMinutes: config.recallIntervalMaxMinutes ?? 240,
      recallMaxPerSession: config.recallMaxPerSession ?? 3,
    },
  })

  // Per-agent activity tracker: the single source of truth for both gates.
  // Created before `rebuild()` so the boot block's `text` closure can consult
  // it, and shared with the digest guard + recall nudge so they never disagree.
  const tracker = new ActivityTracker({ agents: ctx.agents, logger: ctx.logger })

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
    tracker,
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

  // Activity tracker: attach to every live ROOT agent so the two gates
  // (has-user-spoken + active-session) see real user messages as they land.
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(() => {
        tracker.attach(agent)
        return () => {
          tracker.detach(agent.id)
        }
      })
    })
    return () => stopCreated()
  }, 'memory.activity-tracker()')

  // Digest guard: one per live ROOT agent, so a skipped end-of-session
  // digest is caught mechanically instead of relying on the agent's
  // self-discipline. Independent of dsh-plugin-heartbeat — the nudge is
  // a plugin-source followup, queued behind whatever else the agent does.
  if (config.digestNudgeEnabled !== false) {
    ctx.effect(() => {
      const stopCreated = ctx.on('agent/created', ({ agent }) => {
        if (!ctx.agents.roots().includes(agent)) return
        const guard = new DigestGuard(agent, {
          readConfig: () => {
            const resolved = store.get()
            return {
              enabled: resolved.enabled,
              afterMinutes: config.digestNudgeAfterMinutes,
              cooldownMinutes: config.digestNudgeCooldownMinutes,
              maxPerSession: config.digestNudgeMaxPerSession,
              deferUntilUserSpeaks: resolved.deferUntilUserSpeaks,
              activeSessionOnly: resolved.activeSessionOnly,
            }
          },
          getMemoryDir: () => currentMemoryDir,
          agents: ctx.agents,
          tracker,
          logger: ctx.logger,
        })
        agent.ctx.effect(() => {
          guard.start()
          return () => {
            guard.dispose()
          }
        })
      })
      return () => stopCreated()
    }, 'memory.digest-guard()')
  }

  // Recall nudge: one per live ROOT agent, on the same idle boundary as the
  // digest guard but on a cadence (interval + per-session cap) instead of
  // store staleness. Conversational only — it never writes the store.
  if (config.recallEnabled !== false) {
    ctx.effect(() => {
      const stopCreated = ctx.on('agent/created', ({ agent }) => {
        if (!ctx.agents.roots().includes(agent)) return
        const nudge = new RecallNudge(agent, {
          readConfig: () => {
            const resolved = store.get()
            return {
              enabled: resolved.enabled && resolved.recallEnabled !== false,
              minMinutes: resolved.recallIntervalMinMinutes,
              maxMinutes: resolved.recallIntervalMaxMinutes,
              maxPerSession: resolved.recallMaxPerSession,
              deferUntilUserSpeaks: resolved.deferUntilUserSpeaks,
              activeSessionOnly: resolved.activeSessionOnly,
            }
          },
          getMemoryDir: () => currentMemoryDir,
          agents: ctx.agents,
          tracker,
          logger: ctx.logger,
        })
        agent.ctx.effect(() => {
          nudge.start()
          return () => {
            nudge.dispose()
          }
        })
      })
      return () => stopCreated()
    }, 'memory.recall-nudge()')
  }

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
    ctx.logger?.info(`memory: config route at ${CONFIG_ROUTE_PATH} (store ${store.path})`)
  })

  return () => {
    disposeSkill()
    disposeTools()
    disposeCommitter()
    injector.dispose()
    tracker.dispose()
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

export { renderBootBlock, ensureMemoryScaffold, SettingsSchema, MemoryConfigStore, ActivityTracker }
