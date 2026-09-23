/**
 * Boot injection with **part-level** updates.
 *
 * The plugin no longer re-sends the whole memory block whenever one part of
 * the store changes (that made every edit cost the full snapshot). Instead it
 * keeps the block as named parts (see `lib/boot.js`), remembers what the model
 * already has, and injects only the parts that changed:
 *
 * | situation | what is injected |
 * |---|---|
 * | first injection of a session | the full block, `form: 'snapshot'` (a later snapshot from this producer supersedes it) |
 * | one or more parts changed | only those parts, `form: 'notice'` ("this just happened, it supersedes nothing") |
 * | nothing changed | nothing at all — no message, no context churn |
 * | the model no longer has the full block (compaction, session resume) | the full block again |
 *
 * Where the messages come from: an `agent/pre-step` contribution. The block is
 * delivered as a plugin-source user message — the same durable form the host
 * itself uses for runtime context — which is what gives this module the two
 * things a passive `systemPrompt.context()` provider cannot have: per-session
 * state (so unchanged renders cost nothing) and honest framing for partial
 * updates (a snapshot's contract is *supersede*, a notice's is *append*).
 *
 * This module depends only on `node:*` builtins.
 *
 * @module @log.li/dsh-memory/injector
 */

import { randomUUID } from 'node:crypto'
import { renderBootParts } from './boot.js'

/** Section name a full block falls back to when its parts are unknown. */
export const BOOT_SECTION_NAME = 'memory-boot'
/**
 * Prefix of the per-part section names recorded on a full-block injection
 * (`memory:<partId>`). Naming the parts lets a later process reconstruct what
 * the model already holds straight from the durable message, instead of
 * guessing from file timestamps.
 */
export const BOOT_SECTION_PREFIX = 'memory:'
/** Prefix of the one-line account carried by partial-update notices. */
export const NOTICE_SUMMARY_PREFIX = '记忆增量更新'
/** First characters of every partial-update notice (identification + framing). */
export const DELTA_MARKER = '【记忆增量更新'

/**
 * Slack when comparing a file's modification time with the moment an injection
 * was committed. `mtimeMs` carries sub-millisecond precision while event times
 * are whole milliseconds, so a write and the injection that followed it can
 * look simultaneous.
 */
export const MTIME_TOLERANCE_MS = 2

/**
 * @typedef {object} InjectionOptions
 * @property {() => string} getMemoryDir absolute store path (re-read on every render)
 * @property {() => { bootFiles?: string[], bootMaxChars?: number, indexBootMode?: 'off' | 'derive' }} getBootOptions
 * @property {() => object} [getGates] resolved config (master switch + `autoInject`)
 * @property {(agent: object) => boolean} [isRoot] structural rule: only root sessions inject
 * @property {{ info?: Function, warn?: Function, debug?: Function }} [logger]
 * @property {string} [pluginName] producer name recorded in the message source
 */

/**
 * @typedef {{ id: string, text: string, sources: string[], mtimeMs: number }} BootPart
 * @typedef {{ parts: Map<string, BootPart>, baseSeq?: number, lastSeq?: number, lastText?: string }} InjectState
 */

export class BootInjector {
  /**
   * @param {InjectionOptions} options
   */
  constructor(options) {
    this.getMemoryDir = options.getMemoryDir
    this.getBootOptions = options.getBootOptions ?? (() => ({}))
    this.getGates = options.getGates ?? (() => ({}))
    this.isRoot = options.isRoot
    this.logger = options.logger
    this.pluginName = options.pluginName ?? 'memory'
    /** @type {Map<string, InjectState>} per-session injection state */
    this.states = new Map()
    this.disposed = false
  }

  /**
   * `agent/pre-step` waterfall listener: after downstream listeners have
   * shaped the step, append the memory message when there is something to say.
   *
   * @param {{ agent?: object, turn?: number, step?: number }} event
   * @param {() => Promise<{ kind: string, messages: unknown[] }>} next
   * @returns {Promise<{ kind: string, messages: unknown[] }>} the decision
   */
  async handle(event, next) {
    const decision = await next()
    if (this.disposed || decision?.kind === 'reject') return decision
    try {
      const injection = this.render(event?.agent)
      if (injection === undefined) return decision
      return { ...decision, messages: [...decision.messages, buildInjectionMessage(injection, this.pluginName)] }
    } catch (error) {
      // Memory injection must never break the agent loop.
      this.logger?.warn?.(`memory: boot injection failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  }

  /**
   * Decide what (if anything) this step should inject.
   *
   * @param {object | undefined} agent live agent ({ id, session })
   * @returns {{ text: string, form: 'snapshot' | 'notice', summary?: string } | undefined}
   */
  render(agent) {
    const memoryDir = this.getMemoryDir()
    if (typeof memoryDir !== 'string' || memoryDir.length === 0) return undefined
    const boot = renderBootParts(memoryDir, this.getBootOptions())
    if (boot.text.length === 0) return undefined

    const gates = this.getGates()
    if (gates?.enabled === false || gates?.autoInject === false) return undefined
    // Structural rule, not a politeness gate: subagents are ephemeral workers —
    // they neither receive the session's memory block nor refresh it. v0.8.0
    // removed the two activity-based gates, so this is the only filter left.
    if (agent !== undefined && agent !== null && this.isRoot !== undefined && this.isRoot(agent) !== true) return undefined

    const session = agent?.session
    if (session === undefined || session === null) {
      // No session to remember state against (e.g. a preview assembly):
      // inject the full block, statelessly.
      return { text: boot.text, form: 'snapshot', parts: boot.parts }
    }

    const state = this.stateOf(session.id)
    const surface = readSurfaceNodes(session)
    if (surface === null) {
      // The host does not expose the model-visible surface (an API drift on a
      // future host): never diff against a baseline we cannot verify — send the
      // whole block when it differs from what we last sent, and nothing when it
      // does not. No deltas, so a compacted baseline can never be assumed.
      if (this.disposed) return undefined
      if (state.lastText === boot.text) return undefined
      return this.queueFull(state, boot)
    }
    const injections = readOwnInjections(session, this.pluginName)

    if (this.reconcile(state, injections, boot) !== 'ok') {
      return this.queueFull(state, boot)
    }

    const changes = diffParts(state.parts, boot.parts)
    if (changes.changed.length === 0 && changes.removed.length === 0) return undefined

    const text = renderDelta(boot.memoryDir, changes)
    const summary = noticeSummary(changes)
    // Record what the model will have once the host commits this decision; the
    // next render confirms it landed (see `reconcile`).
    state.parts = new Map(boot.parts.map((part) => [part.id, part]))
    state.lastText = text
    state.lastSeq = undefined
    return { text, form: 'notice', summary }
  }

  /**
   * Bring this session's state in line with what the model actually has.
   *
   * Two cases reach here:
   * - **warm** (`state.lastText` set): the newest injection on the surface must
   *   be exactly the text we last sent, and the full block it refines must
   *   still be visible. Anything else — an aborted step that never committed
   *   the message, or a compaction that removed the baseline — re-injects the
   *   full block instead of silently drifting.
   * - **cold** (fresh process, resumed session): adopt the visible injection
   *   when it still describes the store (identical text, or deltas whose source
   *   files have not been touched since), which is what keeps a restart from
   *   costing a redundant 4 KB block.
   *
   * @param {InjectState} state
   * @param {Array<{ seq: number, form: 'snapshot' | 'notice', text: string, time: number }>} injections
   * @param {{ text: string, parts: BootPart[] }} boot
   * @returns {'ok' | 'stale'}
   */
  reconcile(state, injections, boot) {
    const last = injections[injections.length - 1]
    const baseline = [...injections].reverse().find((injection) => injection.form === 'snapshot')

    if (state.lastText !== undefined) {
      if (last === undefined || last.text !== state.lastText) return 'stale'
      if (baseline === undefined) return 'stale'
      state.lastSeq = last.seq
      state.baseSeq = baseline.seq
      return 'ok'
    }

    if (last === undefined || baseline === undefined) return 'stale'
    if (baseline === last) {
      // The only own message is a full block. When it named its parts, adopt
      // exactly those parts — the diff that follows then re-sends just what is
      // out of date, even though this process never sent the block itself.
      if (Array.isArray(last.parts) && last.parts.length > 0) {
        state.parts = new Map(last.parts.map((part) => [part.id, part]))
        state.baseSeq = baseline.seq
        state.lastSeq = last.seq
        state.lastText = last.text
        return 'ok'
      }
      if (last.text !== boot.text) return 'stale'
    } else if (maxSourceMtime(boot.parts) > last.time + MTIME_TOLERANCE_MS) {
      // Deltas refine the block, and a delta names no parts: it only still
      // holds while no source file has been touched since it was computed.
      return 'stale'
    }
    state.parts = new Map(boot.parts.map((part) => [part.id, part]))
    state.baseSeq = baseline.seq
    state.lastSeq = last.seq
    state.lastText = last.text
    return 'ok'
  }

  /**
   * Record a full injection and return it. The previous baseline is dropped:
   * it is exactly the state we just found untrustworthy.
   */
  queueFull(state, boot) {
    state.baseSeq = undefined
    state.lastSeq = undefined
    state.parts = new Map(boot.parts.map((part) => [part.id, part]))
    state.lastText = boot.text
    return { text: boot.text, form: 'snapshot', parts: boot.parts }
  }

  /** Per-session state (created on first use). */
  stateOf(sessionId) {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { parts: new Map(), baseSeq: undefined, lastSeq: undefined, pending: undefined }
      this.states.set(sessionId, state)
    }
    return state
  }

  /** Forget one session's state (or every session when called with nothing). */
  reset(sessionId) {
    if (sessionId === undefined) this.states.clear()
    else this.states.delete(sessionId)
  }

  dispose() {
    this.disposed = true
    this.states.clear()
  }
}

/**
 * Compare the parts the model has with a fresh render.
 *
 * @param {Map<string, BootPart>} confirmed parts the model already has
 * @param {BootPart[]} fresh parts from the current store
 * @returns {{ changed: BootPart[], removed: string[], ids: string[] }}
 */
export function diffParts(confirmed, fresh) {
  const changed = []
  const ids = []
  for (const part of fresh) {
    const previous = confirmed.get(part.id)
    if (previous === undefined || previous.text !== part.text) {
      changed.push(part)
      ids.push(part.id)
    }
  }
  const removed = [...confirmed.keys()].filter((id) => !fresh.some((part) => part.id === id))
  return { changed, removed, ids: [...ids, ...removed.map((id) => `${id}（已移除）`)] }
}

/**
 * Render a partial update: only the changed parts, framed so the model knows
 * the rest of the block still stands.
 *
 * @param {string} memoryDir absolute store path
 * @param {{ changed: BootPart[], removed: string[] }} changes
 * @returns {string}
 */
export function renderDelta(memoryDir, changes) {
  const lines = [
    `${DELTA_MARKER} · @log.li/dsh-memory】记忆库位于 ${memoryDir}。本步只重发**发生变化**的段落；未列出的段落与你此前收到的完全相同、仍然有效。`,
  ]
  for (const part of changes.changed) {
    lines.push('', part.text)
  }
  if (changes.removed.length > 0) {
    lines.push('', `【已移除】${changes.removed.join('、')} —— 这些段落已从记忆库删除，不再适用。`)
  }
  return lines.join('\n')
}

/** One-line account for a partial-update notice (the host bounds it further). */
export function noticeSummary(changes) {
  return `${NOTICE_SUMMARY_PREFIX}：${changes.ids.join('、')}`
}

/**
 * Build the durable plugin message for one injection.
 *
 * A full block is a `snapshot` (its contract: a later snapshot from the same
 * producer supersedes it); a partial update is a `notice` (an account of what
 * just happened, superseding nothing).
 *
 * @param {{ text: string, form: 'snapshot' | 'notice', summary?: string }} injection
 * @param {string} pluginName
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: object }}
 */
export function buildInjectionMessage(injection, pluginName) {
  const parts = Array.isArray(injection.parts) && injection.parts.length > 0 ? injection.parts : undefined
  const source = injection.form === 'snapshot'
    ? {
        kind: 'plugin',
        plugin: pluginName,
        form: 'snapshot',
        sections: parts === undefined
          ? [{ name: BOOT_SECTION_NAME, text: injection.text }]
          : parts.map((part) => ({ name: `${BOOT_SECTION_PREFIX}${part.id}`, text: part.text })),
      }
    : {
        kind: 'plugin',
        plugin: pluginName,
        form: 'notice',
        summary: injection.summary ?? NOTICE_SUMMARY_PREFIX,
      }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: injection.text }],
    source,
  }
}

/**
 * Surface sequence numbers currently visible to the model, or `null` when the
 * session does not expose them (then the caller must not reason about a
 * baseline at all).
 * @param {object} session live session
 * @returns {number[] | null}
 */
export function readSurfaceNodes(session) {
  try {
    const nodes = session?.surface?.nodes
    return Array.isArray(nodes) ? nodes : null
  } catch {
    return null
  }
}

/**
 * Every memory injection still present on the surface, oldest first.
 *
 * @param {object} session live session
 * @param {string} pluginName producer name
 * @returns {Array<{ seq: number, form: 'snapshot' | 'notice', text: string, time: number }>}
 */
export function readOwnInjections(session, pluginName) {
  const out = []
  for (const seq of readSurfaceNodes(session) ?? []) {
    let event
    try {
      event = session.eventAt?.(seq)
    } catch {
      event = undefined
    }
    if (event === undefined || event === null || event.type !== 'user/message') continue
    const data = event.data
    const source = data?.source
    if (source === undefined || source === null || source.kind !== 'plugin' || source.plugin !== pluginName) continue
    const text = messageText(data)
    if (text === undefined || text.length === 0) continue
    // Identification is structural, never a text sniff: a `snapshot` whose
    // sections are ours, or a `notice` that carries both our one-line account
    // and our delta marker. Anything else under this plugin name (a hand-built
    // plugin message without a `form`, say) never enters the ledger.
    if (source.form === 'snapshot' && Array.isArray(source.sections) && isOwnSections(source.sections)) {
      const parts = readSectionParts(source.sections)
      out.push({ seq, form: 'snapshot', text, time: numberOr(event.time, 0), ...(parts === undefined ? {} : { parts }) })
      continue
    }
    if (source.form === 'notice' && typeof source.summary === 'string'
      && source.summary.startsWith(NOTICE_SUMMARY_PREFIX)
      && text.startsWith(DELTA_MARKER)) {
      out.push({ seq, form: 'notice', text, time: numberOr(event.time, 0) })
    }
  }
  return out
}

/** Whether a snapshot's named sections were contributed by this module. */
export function isOwnSections(sections) {
  return sections.some((section) => section?.name === BOOT_SECTION_NAME
    || (typeof section?.name === 'string' && section.name.startsWith(BOOT_SECTION_PREFIX)))
}

/**
 * Reconstruct the parts a full-block snapshot was assembled from — `undefined`
 * when the message predates per-part sections (then only its whole text can be
 * compared).
 * @param {Array<{ name?: unknown, text?: unknown }>} sections
 * @returns {Array<{ id: string, text: string, sources: string[], mtimeMs: number }> | undefined}
 */
export function readSectionParts(sections) {
  const parts = []
  for (const section of sections) {
    if (typeof section?.name !== 'string' || !section.name.startsWith(BOOT_SECTION_PREFIX)) return undefined
    if (typeof section.text !== 'string') return undefined
    parts.push({ id: section.name.slice(BOOT_SECTION_PREFIX.length), text: section.text, sources: [], mtimeMs: 0 })
  }
  return parts.length > 0 ? parts : undefined
}

/** The single text block of a durable message, when it has exactly one. */
function messageText(data) {
  const content = data?.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0]
  if (block === undefined || block === null || block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block.text
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Newest source-file modification time across the rendered parts. */
export function maxSourceMtime(parts) {
  let newest = 0
  for (const part of parts) {
    if (typeof part.mtimeMs === 'number' && Number.isFinite(part.mtimeMs)) newest = Math.max(newest, part.mtimeMs)
  }
  return newest
}
