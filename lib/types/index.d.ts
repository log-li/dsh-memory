/**
 * Type declarations for @log.li/dsh-memory.
 *
 * The implementation is plain ESM JavaScript (zero build step); these
 * declarations describe its public surface for TypeScript consumers.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Plugin entry name. */
export const name: 'memory'

/** Services required by the plugin. */
export const inject: ['skills', 'agents']

/** User-facing plugin configuration (all fields optional). */
export interface MemoryConfig {
  /** Master switch: stops boot injection AND skill registration. Default `true`. */
  enabled?: boolean
  /** Absolute memory-store path; `~` is expanded. Default `'~/.memory'`. */
  memoryDir?: string
  /** Files injected at session start. Default `['MEMORY.md', 'index.md']`. */
  bootFiles?: string[]
  /** Total character budget of the boot block. Default `6000`. */
  bootMaxChars?: number
  /** Inject the boot block at session start. Default `true`. */
  autoInject?: boolean
  /** Catalog boot entries inject the `salience: 1` hot subset. Default `'derive'`. */
  indexBootMode?: 'off' | 'derive'
  /** Register the embedded `memory` skill. Default `true`. */
  registerSkill?: boolean
  /** Register `memory_search` / `memory_read` / `memory_write`. Default `true`. */
  registerTools?: boolean
  /** Silent end-of-turn extraction through the `memory_write` engine. Default `true`. */
  autoMemory?: boolean
  /** Model route for automemory; defaults to the session's own route. */
  autoMemoryProvider?: string
  /** Model id for automemory; defaults to the session's own route. */
  autoMemoryModel?: string
  /** How many times one session may auto-extract. Default `2`. */
  autoMemoryMaxPerSession?: number
  /** Minimum turns between two extractions. Default `3`. */
  autoMemoryMinTurnsBetweenRuns?: number
  /** Skip extraction when the transcript is shorter than this. Default `200`. */
  autoMemoryMinTranscriptChars?: number
  /** Max pages one extraction may write. Default `3`. */
  autoMemoryMaxPages?: number
  /** Max output tokens per automemory call. Default `2000`. */
  autoMemoryMaxTokens?: number
  /** Per-call deadline in milliseconds. Default `60000`. */
  autoMemoryTimeoutMs?: number
  /** Create the store layout and templates when missing. Default `true`. */
  scaffold?: boolean
  /** Absolute user-facing config-file path. Default `<dshHome>/memory.json`. */
  configFile?: string
  /** Auto-commit the store's git history after a quiet period. Default `true`. */
  autoCommit?: boolean
  /** Seconds of quiet before an auto-commit. Default `60`. */
  autoCommitQuietSeconds?: number
  /** Poll interval (seconds) for the auto-committer. Default `60`. */
  autoCommitIntervalSeconds?: number
}

/** Schemastery schema for {@link MemoryConfig}. */
export const Config: import('@deepseek-ai/schemastery').default<MemoryConfig>

/** HTTP route serving the user-facing config to the Settings panel. */
export const CONFIG_ROUTE_PATH: '/api/memory/config'

/** HTTP route answering "is automemory paused for the session I am in?". */
export const AUTOMEMORY_ROUTE_PATH: '/api/memory/automemory'

/**
 * User-editable settings (composition config is the base layer).
 *
 * Keys removed in v0.8.0 (`recall*`, `digestNudge*`, `deferUntilUserSpeaks`,
 * `activeSessionOnly`) are ignored when present in `memory.json`, never an
 * error; the next settings write drops them.
 */
export interface MemorySettings {
  enabled?: boolean
  memoryDir?: string
  autoInject?: boolean
  indexBootMode?: 'off' | 'derive'
  registerSkill?: boolean
  registerTools?: boolean
  autoMemory?: boolean
}

/** Schemastery schema for {@link MemorySettings}. */
export const SettingsSchema: import('@deepseek-ai/schemastery').default<MemorySettings>

/** JSON config store: base + user layer, atomic persist, in-process watch. */
export class MemoryConfigStore {
  constructor(options?: { path?: string; base?: MemorySettings })
  readonly path: string
  get(): MemorySettings
  update(patch: Partial<MemorySettings>): MemorySettings
  watch(callback: (config: MemorySettings) => void): () => void
}

/** Default config-file path (`<dshHome>/memory.json`). */
export function defaultConfigPath(): string

/** Expand `~` and resolve `dir` to an absolute path. */
export function resolveMemoryDir(dir: string): string

/** Callable Cordis plugin entry plus metadata consumed by the DSH loader. */
export interface MemoryPlugin {
  (ctx: Context, config?: MemoryConfig): () => void
  readonly name: 'memory'
  readonly inject: ['skills', 'agents']
  readonly Config: import('@deepseek-ai/schemastery').default<MemoryConfig>
}

/** Cordis plugin entry. Returns the effect disposer. */
export function apply(ctx: Context, config?: MemoryConfig): () => void

declare const plugin: MemoryPlugin

export default plugin

/** Render the boot memory block injected at session start. */
export function renderBootBlock(
  memoryDir: string,
  options?: { bootFiles?: string[]; bootMaxChars?: number; indexBootMode?: 'off' | 'derive' },
): string

/** Create the memory-store layout if missing. Returns created paths. */
export function ensureMemoryScaffold(memoryDir: string): string[]

/**
 * Boot injection with part-level updates (see `lib/injector.js`). Only root
 * sessions are injected; subagents neither receive nor refresh the block.
 */
export class BootInjector {
  constructor(options: {
    getMemoryDir: () => string
    getBootOptions?: () => { bootFiles?: string[]; bootMaxChars?: number; indexBootMode?: 'off' | 'derive' }
    getGates?: () => { enabled?: boolean; autoInject?: boolean }
    isRoot?: (agent: unknown) => boolean
    logger?: { info?: Function; warn?: Function }
    pluginName?: string
  })
  handle(event: unknown, next: () => Promise<unknown>): Promise<unknown>
  render(agent: unknown): { text: string; form: 'snapshot' | 'notice'; summary?: string } | undefined
  reset(sessionId?: string): void
  dispose(): void
}

/** Optional end-of-turn extraction (default ON since v0.8.0). */
export class AutoMemory {
  constructor(agent: unknown, options: {
    readConfig: () => MemoryConfig
    getMemoryDir: () => string
    isPaused?: (sessionId: string) => boolean
    isRoot?: (agent: unknown) => boolean
    logger?: { info?: Function; warn?: Function }
  })
  start(): void
  dispose(): void
  eligibility(): { run: boolean; reason: string }
  maybeRun(): Promise<{ remembered: boolean; reason: string; wrote: number; paths: string[]; called: number } | undefined>
}
