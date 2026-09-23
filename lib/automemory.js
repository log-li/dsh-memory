/**
 * Optional automemory: extract what a finished session is worth remembering.
 *
 * Off by default — this is the only path that writes the store without the
 * model deciding to (see the project spec, §5.4). When enabled it runs at the
 * same idle boundary the digest guard uses (`agent/turn-stopping`) and does a
 * **two-stage** pass over the session transcript:
 *
 * 1. **classify** — "did this session produce anything durable?" A cheap call
 *    that must answer with strict JSON; a `remember: false` answer ends the run
 *    with no second call and no write.
 * 2. **extract** — "write the pages", again strict JSON, then the same
 *    `writeMemoryPage` engine the `memory_write` tool uses: duplicate check,
 *    `ifVersion` for updates, catalog row, derived subset, optional log entry.
 *
 * Guardrails, because an unattended writer is the riskiest part of this plugin:
 * it only runs for a session the user is actually talking to, never twice in a
 * row without new turns, at most `autoMemoryMaxPerSession` times per session,
 * never when the agent already wrote the store during that turn (its own digest
 * wins), never outside `<memoryDir>`, and never at the cost of the agent loop —
 * every failure is logged and swallowed.
 *
 * This module depends only on `node:*` builtins.
 *
 * @module @log.li/dsh-memory/automemory
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_FILENAME } from './index-format.js'
import { latestMtimeMs } from './autocommit.js'
import { appendLogEntry, readMemoryPage, writeMemoryPage, MemoryOperationError } from './pages.js'
import { readSurfaceNodes } from './injector.js'

/** How much transcript one extraction call may see. */
export const MAX_TRANSCRIPT_CHARS = 8000
/** How much of the catalog the extraction call may see. */
export const MAX_CATALOG_CHARS = 6000
/** Hard cap on one page body a model may write in a single run. */
export const MAX_PAGE_CHARS = 12000

/** System prompt of stage 1. */
export const CLASSIFY_SYSTEM = [
  '你判断一段会话是否产出了值得写入长期记忆库的内容。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏：',
  '{"remember": true|false, "reason": "一句话理由", "topics": ["主题"]}',
  '',
  '值得记：关于用户的稳定事实与偏好、决策及其理由、项目背景与状态变化、可复用的工具/环境坑与工作流。',
  '不值得记：临时状态、寒暄、能从代码或当前对话直接看到的内容、未经确认的推测。',
  '宁缺勿滥：不确定就 remember=false。',
].join('\n')

/** System prompt of stage 2. */
export const EXTRACT_SYSTEM = [
  '你把会话里值得长期保存的内容写成记忆库页面，并给出目录行与时间线条目。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏：',
  '{"pages":[{"path":"decisions/x.md","content":"---\\ntitle: …\\ndate: YYYY-MM-DD\\ntype: decision\\nsalience: 2\\n---\\n\\n# …\\n\\n正文","summary":"写入 index.md 的一行摘要","salience":1}],"logEntry":"decision | 一句话"}',
  '',
  '规则：',
  '- path 一律用记忆库相对路径，落在 identity/ user/ skills/ decisions/ projects/ concepts/ 之下；**绝不**写 raw/。',
  '- 已有同主题页时**更新它**（沿用它的 path，content 给完整新正文），不要新建近似重复页。',
  '- salience：1=每次会话都要看（规则/常驻事实）、2=按需检索（多数页）、3=冷页。宁 2 勿 1。',
  '- 用会话本身的语言写正文；正文要能被未来的自己直接读懂，不写「本次会话」这类相对说法。',
  '- 没有任何值得写的就回 {"pages":[],"logEntry":null}。',
].join('\n')

/**
 * Collect one model stream into text (+ its terminal finish reason).
 * @param {AsyncIterable<object>} stream
 * @returns {Promise<{ text: string, finish?: string }>}
 */
export async function collectStreamText(stream) {
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  return { text, finish }
}

/**
 * Pull the first JSON object out of a model answer (tolerating prose or code
 * fences around it), so a chatty model cannot silently disable extraction.
 * @param {string} text
 * @returns {object | undefined}
 */
export function parseJsonObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(source.slice(start, index + 1))
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** A durable message's plain text (single text block, or joined text blocks). */
function messageText(data) {
  const content = data?.content
  if (!Array.isArray(content)) return undefined
  const parts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * The session transcript as the extraction stages see it: real user messages
 * and assistant text, oldest first, trimmed to the newest `maxChars`.
 *
 * @param {object} session live session
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function readTranscript(session, options = {}) {
  const maxChars = Math.max(200, options.maxChars ?? MAX_TRANSCRIPT_CHARS)
  const nodes = readSurfaceNodes(session) ?? []
  const lines = []
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt?.(seq)
    } catch {
      event = undefined
    }
    if (event === undefined || event === null) continue
    const text = messageText(event.data)
    if (text === undefined || text.trim().length === 0) continue
    const source = event.data?.source
    if (event.type === 'user/message' && source?.kind === 'user') lines.push(`用户：${text}`)
    else if (event.type === 'assistant/message') lines.push(`助手：${text}`)
  }
  const joined = lines.join('\n\n')
  if (joined.length <= maxChars) return joined
  return `…（较早内容已省略）\n\n${joined.slice(-maxChars)}`
}

/**
 * Build the stage-1 request body (pure, so it can be asserted in tests).
 * @param {string} transcript
 * @returns {string}
 */
export function classifyPrompt(transcript) {
  return ['以下是一段会话记录（用户与助手）。判断它是否产出了值得写入长期记忆的内容。', '', transcript].join('\n')
}

/**
 * Build the stage-2 request body (pure).
 * @param {string} transcript
 * @param {string} catalog current `index.md` (truncated)
 * @returns {string}
 */
export function extractPrompt(transcript, catalog) {
  return [
    '会话记录：',
    '',
    transcript,
    '',
    '记忆库当前目录（index.md，供你决定更新哪个已有页面）：',
    '',
    catalog,
  ].join('\n')
}

/**
 * One `AutoMemory` per live root agent: it observes turn boundaries, decides
 * whether to run, and performs the two-stage extraction.
 */
export class AutoMemory {
  /**
   * @param {object} agent live root agent ({ id, ctx, session, followup })
   * @param {{
   *   readConfig: () => object,
   *   getMemoryDir: () => string,
   *   isPaused?: (sessionId: string) => boolean,
   *   tracker?: { shouldInject?: (agentId: string, config: object) => boolean },
   *   logger?: { info?: Function, warn?: Function },
   *   now?: () => number,
   * }} options
   */
  constructor(agent, options) {
    this.agent = agent
    this.options = options
    this.logger = options.logger
    this.runs = 0
    this.turnsSinceRun = 0
    /** Set when a run could not reach the model at all (a route/service issue). */
    this.unroutable = false
    this.running = false
    this.disposed = false
    this.stopTurnStart = undefined
    this.stopTurnStopping = undefined
    this.storeMtimeAtTurnStart = undefined
    this.sessionId = agent?.session?.id
  }

  /**
   * Begin observing this agent's turn boundaries.
   *
   * Turn starts are **session** events (`turn/start` appended to the session
   * log), not agent events — the agent-scoped dispatcher only emits
   * `agent/turn-stopping` (and friends). Subscribing to the wrong one made the
   * turn counter stand still, which no unit test noticed and the isolated
   * instance did; hence the session/event subscription below.
   */
  start() {
    if (this.disposed) return
    this.stopTurnStart = this.agent.ctx?.on?.('session/event', (subject, event) => {
      if (this.agent?.session !== undefined && subject !== this.agent.session) return
      if (event?.type !== 'turn/start') return
      this.turnsSinceRun += 1
      this.storeMtimeAtTurnStart = this.storeMtime()
    })
    this.stopTurnStopping = this.agent.ctx?.on?.('agent/turn-stopping', () => {
      void this.maybeRun()
    })
  }

  dispose() {
    this.disposed = true
    try {
      this.stopTurnStart?.()
      this.stopTurnStopping?.()
    } catch (error) {
      this.logger?.warn?.(`memory: automemory listener teardown failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Current store modification time, or `undefined` when it cannot be read
   * (no store / unreadable). `undefined` is deliberately distinct from `0`
   * (an existing but empty store): only a known value may gate a run.
   * @returns {number | undefined}
   */
  storeMtime() {
    const dir = this.options.getMemoryDir?.()
    if (typeof dir !== 'string' || dir.length === 0) return undefined
    try {
      if (!existsSync(dir)) return undefined
      return latestMtimeMs(dir)
    } catch {
      return undefined
    }
  }

  /**
   * Why a run is or is not allowed right now.
   * @returns {{ run: boolean, reason: string }}
   */
  eligibility() {
    const config = this.options.readConfig?.() ?? {}
    if (this.disposed) return { run: false, reason: 'disposed' }
    if (config.enabled === false) return { run: false, reason: 'plugin disabled' }
    if (config.autoMemory !== true) return { run: false, reason: 'automemory off' }
    if (this.running) return { run: false, reason: 'already running' }
    if (this.sessionId !== undefined && this.options.isPaused?.(this.sessionId) === true) return { run: false, reason: 'paused for this session' }
    if (this.unroutable) {
      // A configuration-level failure (no provider/model route, no llm
      // service) would otherwise be retried at every eligible turn. Latch it,
      // but recover as soon as a route is resolvable again.
      if (this.resolveRoute(config) === undefined || this.llm === undefined) {
        return { run: false, reason: 'no model route available' }
      }
      this.unroutable = false
    }
    if (this.runs >= (config.autoMemoryMaxPerSession ?? 2)) return { run: false, reason: 'session cap reached' }
    if (this.turnsSinceRun < (config.autoMemoryMinTurnsBetweenRuns ?? 3)) return { run: false, reason: 'waiting for more turns' }
    const tracker = this.options.tracker
    if (tracker?.shouldInject !== undefined && this.agent?.id !== undefined
      && tracker.shouldInject(this.agent.id, config) !== true) {
      return { run: false, reason: 'session not active' }
    }
    const transcript = this.transcript()
    if (transcript.length < (config.autoMemoryMinTranscriptChars ?? 200)) return { run: false, reason: 'transcript too small' }
    // The agent digested the store during this turn: its judgement wins.
    const mtime = this.storeMtime()
    if (this.storeMtimeAtTurnStart !== undefined && mtime !== undefined && mtime > this.storeMtimeAtTurnStart) {
      return { run: false, reason: 'store already written this turn' }
    }
    return { run: true, reason: 'ok' }
  }

  /** Current transcript, bounded. */
  transcript() {
    try {
      return readTranscript(this.agent?.session, { maxChars: MAX_TRANSCRIPT_CHARS })
    } catch {
      return ''
    }
  }

  /** Run the two stages when eligible; never throws. */
  async maybeRun() {
    const verdict = this.eligibility()
    if (!verdict.run) {
      this.logger?.debug?.(`memory: automemory skipped (${verdict.reason})`)
      return undefined
    }
    this.running = true
    let called = 0
    try {
      const report = await this.run()
      called = report.called
      if (report.wrote > 0) {
        this.logger?.info?.(`memory: automemory wrote ${report.wrote} page(s) (${report.paths.join(', ')})`)
      } else {
        this.logger?.info?.(`memory: automemory found nothing to remember (${report.reason})`)
      }
      return report
    } catch (error) {
      this.logger?.warn?.(`memory: automemory failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      this.running = false
      // Any attempt counts against the session budget — including one whose
      // model call threw or timed out — so a broken route cannot be retried
      // forever. A run that never reached the model at all is latched instead
      // (see `eligibility`), because that is a configuration problem, not a
      // budget question.
      this.runs += 1
      this.turnsSinceRun = 0
      if (called === 0) this.unroutable = true
    }
  }

  /**
   * Call the model once for one stage.
   * @param {string} system system prompt
   * @param {string} prompt user prompt
   * @returns {Promise<{ text: string, finish?: string } | undefined>}
   */
  async ask(system, prompt) {
    const config = this.options.readConfig?.() ?? {}
    const route = this.resolveRoute(config)
    if (route === undefined) {
      this.logger?.warn?.('memory: automemory skipped — no provider/model route available')
      return undefined
    }
    const llm = this.llm
    if (llm === undefined) {
      this.logger?.warn?.('memory: automemory skipped — no llm service available')
      return undefined
    }
    const message = {
      id: `automemory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'memory' },
    }
    const timeoutMs = Math.max(1000, Number(config.autoMemoryTimeoutMs) || 60000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [message],
        maxTokens: Math.max(128, Number(config.autoMemoryMaxTokens) || 2000),
        ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
        signal: controller.signal,
      })
      // The host contract says adapters honor `signal`, but a stalled stream
      // must not be able to wedge this session's automemory for good: race the
      // accumulation against the same deadline.
      return await Promise.race([
        collectStreamText(stream),
        new Promise((resolve) => {
          const guard = setTimeout(() => {
            controller.abort()
            resolve(undefined)
          }, timeoutMs + 1000)
          guard.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The route to call: composition config first, then the session's own routed
   * model, then the agent's own options.
   * @param {object} config resolved plugin config
   * @returns {{ provider: string, model: string } | undefined}
   */
  resolveRoute(config) {
    const configuredProvider = typeof config.autoMemoryProvider === 'string' ? config.autoMemoryProvider.trim() : ''
    const configuredModel = typeof config.autoMemoryModel === 'string' ? config.autoMemoryModel.trim() : ''
    if (configuredProvider.length > 0 && configuredModel.length > 0) {
      return { provider: configuredProvider, model: configuredModel }
    }
    let header
    try {
      header = this.agent?.session?.requestHeader?.()?.config
    } catch {
      header = undefined
    }
    if (typeof header?.provider === 'string' && typeof header?.model === 'string'
      && header.provider.length > 0 && header.model.length > 0) {
      return { provider: header.provider, model: header.model }
    }
    const options = this.agent?.options
    if (typeof options?.provider === 'string' && typeof options?.model === 'string'
      && options.provider.length > 0 && options.model.length > 0) {
      return { provider: options.provider, model: options.model }
    }
    return undefined
  }

  /** The `llm` service, read lazily so a missing service degrades to a skip. */
  get llm() {
    try {
      return this.agent?.ctx?.get?.('llm') ?? this.options.llm
    } catch {
      return undefined
    }
  }

  /**
   * Stage 1 + stage 2, then the writes.
   * @returns {Promise<{ remembered: boolean, reason: string, wrote: number, paths: string[], called: number }>}
   *   `called` counts the model calls that actually went out.
   */
  async run() {
    const memoryDir = this.options.getMemoryDir?.()
    const transcript = this.transcript()
    if (typeof memoryDir !== 'string' || memoryDir.length === 0) return { remembered: false, reason: 'no store', wrote: 0, paths: [], called: 0 }

    let called = 0
    const classified = await this.ask(CLASSIFY_SYSTEM, classifyPrompt(transcript))
    if (classified === undefined) return { remembered: false, reason: 'no model route', wrote: 0, paths: [], called }
    called += 1
    const decision = parseJsonObject(classified?.text)
    if (decision?.remember !== true) {
      return { remembered: false, reason: typeof decision?.reason === 'string' ? decision.reason : 'classifier said no', wrote: 0, paths: [], called }
    }

    const extracted = await this.ask(EXTRACT_SYSTEM, extractPrompt(transcript, this.catalog(memoryDir)))
    if (extracted === undefined) return { remembered: false, reason: 'no model route', wrote: 0, paths: [], called }
    called += 1
    const plan = parseJsonObject(extracted?.text)
    const pages = Array.isArray(plan?.pages) ? plan.pages : []
    const maxPages = Math.max(1, Number(this.options.readConfig?.()?.autoMemoryMaxPages) || 3)
    const written = []
    for (const page of pages.slice(0, maxPages)) {
      const applied = this.writePage(memoryDir, page)
      if (applied !== undefined) written.push(applied)
    }
    const logEntry = typeof plan?.logEntry === 'string' && plan.logEntry.trim().length > 0 ? plan.logEntry : undefined
    if (written.length > 0 && logEntry !== undefined) {
      try {
        appendLogEntry(memoryDir, logEntry)
      } catch (error) {
        this.logger?.warn?.(`memory: automemory log entry failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      remembered: written.length > 0,
      reason: written.length > 0 ? 'extracted' : 'extractor produced no page',
      wrote: written.length,
      paths: written,
      called,
    }
  }

  /** Write one extracted page, returning its path when it landed. */
  writePage(memoryDir, page) {
    if (page === null || typeof page !== 'object') return undefined
    const path = typeof page.path === 'string' ? page.path.trim() : ''
    const content = typeof page.content === 'string' ? page.content : ''
    if (path.length === 0 || content.trim().length === 0) return undefined
    if (content.length > MAX_PAGE_CHARS) {
      this.logger?.warn?.(`memory: automemory rejected ${path} (${content.length} chars > ${MAX_PAGE_CHARS})`)
      return undefined
    }
    const summary = typeof page.summary === 'string' ? page.summary : undefined
    const salience = page.salience === 1 || page.salience === 3 ? page.salience : undefined
    try {
      const target = join(memoryDir, path)
      const existing = existsSync(target) ? readMemoryPage(memoryDir, path) : undefined
      const report = writeMemoryPage(memoryDir, {
        path,
        content,
        ...(existing === undefined ? {} : { ifVersion: existing.version }),
        ...(summary === undefined ? {} : { summary }),
        ...(salience === undefined ? {} : { salience }),
      })
      return report.path
    } catch (error) {
      if (error instanceof MemoryOperationError) {
        this.logger?.warn?.(`memory: automemory skipped ${path}: ${error.code} ${error.message}`)
        return undefined
      }
      throw error
    }
  }

  /** The catalog text the extraction stage may see (bounded). */
  catalog(memoryDir) {
    try {
      const text = readFileSync(join(memoryDir, INDEX_FILENAME), 'utf8')
      return text.length > MAX_CATALOG_CHARS ? `${text.slice(0, MAX_CATALOG_CHARS)}\n…（目录已截断）` : text
    } catch {
      return '（暂无 index.md）'
    }
  }
}
