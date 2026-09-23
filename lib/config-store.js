/**
 * Memory configuration store: one JSON file as the single user-facing
 * config source, layered over the composition defaults.
 *
 * v0.8.0 removed the persona-side keys (`recall*`, `digestNudge*`,
 * `deferUntilUserSpeaks`, `activeSessionOnly`): a `memory.json` that still
 * carries them is read with those keys ignored — never an error — and the next
 * settings write drops them from the file.
 *
 * Why not the `settings` service? The Web settings wire only serves a
 * hard-coded allowlist (`WEB_SETTINGS_NAMESPACES` in dsh-host-apiproxy) and
 * rejects every other namespace with `settings-not-exposed`; a plugin cannot
 * add itself to that list yet. This store keeps the same "base + user layer"
 * semantics with a private JSON file and an in-process watch, and the plugin
 * serves it over its own HTTP route for the browser UI.
 *
 * @module @log.li/dsh-memory/config-store
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { SettingsSchema } from './schema.js'

export const MEMORY_CONFIG_FILENAME = 'memory.json'

export function defaultConfigPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), MEMORY_CONFIG_FILENAME)
}

const FIELDS = ['enabled', 'memoryDir', 'autoInject', 'registerSkill', 'registerTools', 'indexBootMode', 'autoMemory']

function pickFields(input) {
  const picked = {}
  for (const key of FIELDS) {
    if (input[key] !== undefined) picked[key] = input[key]
  }
  return picked
}

/**
 * @typedef {object} MemorySettings
 * @property {boolean} enabled
 * @property {string} memoryDir
 * @property {boolean} autoInject
 * @property {boolean} registerSkill
 * @property {boolean} registerTools
 * @property {'off' | 'derive'} indexBootMode
 * @property {boolean} autoMemory
 */

/**
 * @param {object} options
 * @param {string} [options.path] absolute config-file path (defaults to `<dshHome>/memory.json`)
 * @param {object} [options.base] composition defaults ({enabled, memoryDir, autoInject, registerSkill, registerTools, indexBootMode, autoMemory})
 */
export class MemoryConfigStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultConfigPath()
    this.base = {
      enabled: options.base?.enabled !== false,
      memoryDir: typeof options.base?.memoryDir === 'string' && options.base.memoryDir.trim().length > 0
        ? options.base.memoryDir
        : '~/.memory',
      autoInject: options.base?.autoInject !== false,
      registerSkill: options.base?.registerSkill !== false,
      registerTools: options.base?.registerTools !== false,
      indexBootMode: options.base?.indexBootMode === 'off' ? 'off' : 'derive',
      autoMemory: options.base?.autoMemory !== false,
    }
    this.config = { ...this.base }
    this.watchers = new Set()
    this.load()
  }

  /** Read the user file if present; invalid files are ignored, not fatal. */
  load() {
    let raw
    try {
      if (!existsSync(this.path)) return
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return // corrupt file: keep last good config
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
    try {
      const picked = pickFields(raw)
      if (picked.memoryDir !== undefined && (typeof picked.memoryDir !== 'string' || picked.memoryDir.trim().length === 0)) return
      const resolved = SettingsSchema({ ...this.base, ...picked })
      this.config = {
        enabled: resolved.enabled,
        memoryDir: resolved.memoryDir,
        autoInject: resolved.autoInject,
        registerSkill: resolved.registerSkill,
        registerTools: resolved.registerTools,
        indexBootMode: resolved.indexBootMode,
        autoMemory: resolved.autoMemory,
      }
    } catch {
      // schema validation failed: keep last good config
    }
  }

  /** Current effective config (stable reference until the next update). */
  get() {
    return this.config
  }

  /**
   * Apply a partial update, persist it, and notify watchers.
   * @param {Partial<MemorySettings>} patch
   * @returns {MemorySettings} the new effective config
   * @throws {Error} on invalid fields or values
   */
  update(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('config patch must be an object')
    const picked = pickFields(patch)
    if (picked.memoryDir !== undefined && (typeof picked.memoryDir !== 'string' || picked.memoryDir.trim().length === 0)) {
      throw new Error('memoryDir must be a non-empty path string')
    }
    const next = SettingsSchema({
      ...this.base,
      ...this.config,
      ...picked,
    })
    this.config = {
      enabled: next.enabled,
      memoryDir: next.memoryDir,
      autoInject: next.autoInject,
      registerSkill: next.registerSkill,
      registerTools: next.registerTools,
      indexBootMode: next.indexBootMode,
      autoMemory: next.autoMemory,
    }
    this.persist()
    for (const watcher of this.watchers) {
      try {
        watcher(this.config)
      } catch {
        // best-effort notification
      }
    }
    return this.config
  }

  /** Subscribe to config changes; returns the disposer. */
  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch (error) {
      // Persistence is best-effort; the in-memory config is already applied.
      // Surface the failure so the route can report it.
      throw new Error(`config persisted in memory but not to disk: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
