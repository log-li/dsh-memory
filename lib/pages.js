/**
 * Memory pages: reading, searching, and the two-step write.
 *
 * The store is plain markdown, so "the write path" is really a protocol:
 * find the page that already covers the topic (or learn that one does) → write
 * the page with an optimistic-concurrency check → keep the catalog's one-line
 * row and the derived hot subset in sync. `memory_write` is the machine
 * enforcement of that protocol; this module is its engine, kept free of any
 * tool-registry types so it can be tested (and reused by the CLI) directly.
 *
 * Data-plane rules enforced here:
 * - every path must resolve inside the store (no traversal, no absolute escapes);
 * - `raw/` is read-only source material and is never written;
 * - the catalog row format is the upstream one (`- [title](path) — summary`);
 * - the derived hot subset is a rebuildable artifact, never a source of truth.
 *
 * This module depends only on `node:*` builtins.
 *
 * @module @log.li/dsh-memory/pages
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  DERIVED_INDEX_FILENAME,
  INDEX_FILENAME,
  HOT_SALIENCE,
  deriveIndexSubset,
  normalizeIndexPath,
  upsertIndexRow,
} from './index-format.js'

/** Read-only source material (never written, excluded from search by default). */
export const RAW_DIR = 'raw'
/** Files that are derived or structural rather than searchable pages. */
export const NON_PAGE_FILES = new Set([INDEX_FILENAME, DERIVED_INDEX_FILENAME])
/** The timeline: searchable only on request (it is long and low-signal by keyword). */
export const LOG_FILENAME = 'log.md'
/**
 * Files the write engine owns: the catalog, its derived subset and the
 * timeline. `writeMemoryPage` maintains them (one row per page, timestamped
 * entries) — a model-supplied path must not be able to replace them wholesale.
 */
export const ENGINE_OWNED_FILES = new Set([INDEX_FILENAME, DERIVED_INDEX_FILENAME, LOG_FILENAME])
/** Largest page the tools will read or search in one go. */
export const MAX_PAGE_BYTES = 512 * 1024

/** A rejected memory operation, carrying a stable machine-readable code. */
export class MemoryOperationError extends Error {
  /**
   * @param {'OUT_OF_STORE' | 'RAW_READONLY' | 'NOT_A_PAGE' | 'NOT_FOUND' | 'CONFLICT' | 'DUPLICATE' | 'INVALID'} code
   * @param {string} message model-facing explanation
   * @param {object} [details] extra structured facts (existing version, candidates…)
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MemoryOperationError'
    this.code = code
    this.details = details
  }
}

/**
 * Resolve a store-relative path, refusing anything that escapes the store —
 * both lexically (`../`, absolute paths) **and through symlinks**: a link
 * inside the store pointing outside it would otherwise let a write land
 * anywhere on disk, and a link onto `raw/` would defeat the read-only guard.
 *
 * @param {string} root absolute store path
 * @param {string} candidate store-relative (or absolute-inside) path
 * @returns {{ absolute: string, relative: string, realRelative: string }}
 *   `relative` is the lexical store-relative path, `realRelative` the same path
 *   with every existing symlink resolved (equal to `relative` for plain paths)
 */
export function resolveInside(root, candidate) {
  const raw = String(candidate ?? '').trim()
  if (raw.length === 0) throw new MemoryOperationError('INVALID', 'path must be a non-empty string')
  const rootAbs = resolve(root)
  const absolute = resolve(rootAbs, raw)
  const rel = relative(rootAbs, absolute)
  if (rel.length === 0) throw new MemoryOperationError('NOT_A_PAGE', `${raw} is the memory store itself, not a page`)
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rootAbs, rel) !== absolute) {
    throw new MemoryOperationError('OUT_OF_STORE', `${raw} 不在记忆库内（只允许记忆库相对路径）`)
  }
  const realRelative = resolveRealRelative(rootAbs, absolute)
  if (realRelative === undefined) {
    throw new MemoryOperationError('OUT_OF_STORE', `${raw} 经符号链接指向记忆库外：拒绝访问`)
  }
  return { absolute, relative: normalizeIndexPath(rel), realRelative }
}

/** realpath, or undefined when the path does not exist / cannot be resolved. */
function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The store-relative path of `absolute` with symlinks resolved, or `undefined`
 * when the resolved location leaves the store. Resolves the deepest existing
 * ancestor and re-appends the not-yet-existing tail, so `memory_write` can
 * create a page inside a new directory while staying contained.
 * @param {string} rootAbs absolute store root
 * @param {string} absolute absolute candidate path
 * @returns {string | undefined}
 */
export function resolveRealRelative(rootAbs, absolute) {
  const rootReal = realpathOrUndefined(rootAbs) ?? rootAbs
  const tail = []
  let probe = absolute
  for (;;) {
    const real = realpathOrUndefined(probe)
    if (real !== undefined) {
      const rel = relative(rootReal, real)
      if (rel === '') return normalizeIndexPath(tail.join('/'))
      if (rel === '..' || rel.startsWith(`..${sep}`)) return undefined
      return normalizeIndexPath([rel, ...tail].join('/'))
    }
    // Nothing above the store root can be a link we must follow: when the root
    // itself does not exist yet, the lexical path is the resolved path.
    if (probe === rootAbs) return normalizeIndexPath(tail.join('/'))
    const parent = dirname(probe)
    if (parent === probe) return undefined
    tail.unshift(base(probe))
    probe = parent
  }
}

/** Basename without importing it twice under different names. */
function base(path) {
  const index = path.lastIndexOf(sep)
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Parse YAML-ish frontmatter (flat `key: value` pairs only — the store's own
 * schema). Returns the body unchanged when there is no frontmatter block.
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(text) {
  const source = text ?? ''
  if (!source.startsWith('---')) return { data: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: source }
  const block = source.slice(3, end)
  const data = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    data[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
  }
  return { data, body: source.slice(end + 4).replace(/^\r?\n/, '') }
}

/**
 * A page's identity as the catalog sees it.
 * @param {string} content page body
 * @param {string} relPath store-relative path
 * @returns {{ title: string, salience: number, summary: string }}
 */
export function describeMemoryPage(content, relPath) {
  const { data, body } = parseFrontmatter(content)
  let title = (data.title ?? '').trim()
  if (title.length === 0) {
    const heading = /^#\s+(.+)$/m.exec(body)
    title = heading ? heading[1].trim() : basename(normalizeIndexPath(relPath), '.md')
  }
  const salience = Number(data.salience) === 1 || Number(data.salience) === 3 ? Number(data.salience) : 2
  let summary = (data.summary ?? data.description ?? '').trim()
  if (summary.length === 0) {
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('---')) continue
      summary = trimmed
      break
    }
  }
  summary = summary.replace(/\*\*/g, '').replace(/`/g, '')
  const points = [...summary]
  if (points.length > 160) summary = `${points.slice(0, 159).join('')}…`
  return { title, salience, summary }
}

/** Content-addressed page version: the optimistic-concurrency token. */
export function pageVersion(content) {
  return createHash('sha1').update(content ?? '', 'utf8').digest('hex').slice(0, 12)
}

/**
 * Refuse a location that is (or resolves to) the read-only `raw/` material.
 *
 * Both paths are already normalized by `resolveInside` (so `raw/../x.md` reads
 * as `x.md` and is allowed, as it should be); the check is by path segment, not
 * substring, so a page named `raw-notes.md` is not mistaken for `raw/`.
 * @param {string} rel lexical store-relative path
 * @param {string} realRel symlink-resolved store-relative path
 */
function assertNotRaw(rel, realRel) {
  for (const candidate of [rel, realRel]) {
    if (candidate === RAW_DIR || candidate.startsWith(`${RAW_DIR}/`)) {
      throw new MemoryOperationError('RAW_READONLY', `${rel} 位于 raw/ 下：源材料只读，请写分类页（identity/ user/ skills/ decisions/ projects/ concepts/）`)
    }
  }
}

/**
 * Every markdown page in the store (excluding `.git`, the catalog, and — by
 * default — the read-only `raw/` material).
 * @param {string} memoryDir
 * @param {{ includeRaw?: boolean, includeCatalog?: boolean, includeLog?: boolean }} [options]
 * @returns {string[]} store-relative paths, sorted
 */
export function listPages(memoryDir, options = {}) {
  const root = resolve(memoryDir)
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      const rel = normalizeIndexPath(relative(root, absolute))
      if (entry.isDirectory()) {
        if (entry.name === RAW_DIR && options.includeRaw !== true) continue
        walk(absolute)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      if (options.includeCatalog !== true && NON_PAGE_FILES.has(entry.name)) continue
      if (options.includeLog !== true && entry.name === LOG_FILENAME) continue
      out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

/** Read one page, refusing anything outside the store or over the size cap. */
export function readMemoryPage(memoryDir, relPath) {
  const { absolute, relative: rel } = resolveInside(memoryDir, relPath)
  assertNotRaw(rel, rel)
  if (!rel.endsWith('.md')) throw new MemoryOperationError('NOT_A_PAGE', `${rel} 不是 markdown 页面`)
  if (!existsSync(absolute)) throw new MemoryOperationError('NOT_FOUND', `记忆库中没有 ${rel}`)
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new MemoryOperationError('NOT_FOUND', `${rel} 不是文件`)
  if (stats.size > MAX_PAGE_BYTES) {
    throw new MemoryOperationError('INVALID', `${rel} 过大（${stats.size} 字节 > ${MAX_PAGE_BYTES}），请用 search 定位后再读片段`)
  }
  const text = readFileSync(absolute, 'utf8')
  const meta = describeMemoryPage(text, rel)
  return { path: rel, absolutePath: absolute, text, version: pageVersion(text), bytes: Buffer.byteLength(text, 'utf8'), ...meta }
}

/**
 * Keyword search over the store's pages.
 *
 * Every query term is matched case-insensitively against the title, the path,
 * and the body. Pages matching **all** terms rank first; when nothing matches
 * every term, pages matching some terms are returned with `partial: true` so
 * the caller can widen its wording instead of concluding "no such memory".
 *
 * @param {string} memoryDir
 * @param {{ query: string, limit?: number, includeRaw?: boolean, includeLog?: boolean }} options
 * @returns {{ query: string, terms: string[], scanned: number, partial: boolean, results: Array<object> }}
 */
export function searchMemory(memoryDir, options) {
  const query = String(options?.query ?? '').trim()
  const terms = query.split(/[\s,，、]+/).map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0)
  if (terms.length === 0) throw new MemoryOperationError('INVALID', 'query 不能为空')
  const limit = Math.min(Math.max(Number(options?.limit) || 8, 1), 25)

  const all = []
  const pages = listPages(memoryDir, {
    includeRaw: options?.includeRaw === true,
    includeLog: options?.includeLog === true,
  })
  for (const rel of pages) {
    let text
    try {
      const stats = statSync(join(memoryDir, rel))
      if (stats.size > MAX_PAGE_BYTES) continue
      text = readFileSync(join(memoryDir, rel), 'utf8')
    } catch {
      continue
    }
    const meta = describeMemoryPage(text, rel)
    const haystackTitle = meta.title.toLowerCase()
    const haystackPath = rel.toLowerCase()
    const lines = text.split('\n')
    const lowerLines = lines.map((line) => line.toLowerCase())

    let hitAll = true
    let score = 0
    const hits = new Map()
    for (const term of terms) {
      let matched = false
      if (haystackTitle.includes(term)) {
        score += 6
        matched = true
      }
      if (haystackPath.includes(term)) {
        score += 3
        matched = true
      }
      let occurrences = 0
      for (let i = 0; i < lowerLines.length; i += 1) {
        if (!lowerLines[i].includes(term)) continue
        occurrences += 1
        if (occurrences <= 5) score += 1
        if (!hits.has(i)) hits.set(i, lines[i].trim().slice(0, 200))
      }
      if (occurrences > 0) matched = true
      if (!matched) hitAll = false
    }
    if (score === 0) continue
    all.push({ path: rel, title: meta.title, salience: meta.salience, summary: meta.summary, score, matches: [...hits.entries()].slice(0, 3).map(([line, text]) => ({ line: line + 1, text })), hitAll })
  }

  const complete = all.filter((entry) => entry.hitAll)
  const partial = complete.length === 0 && all.length > 0
  const pool = (partial ? all : complete).filter((entry) => entry.score > 0)
  pool.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
  const results = pool.slice(0, limit).map(({ hitAll: _hitAll, ...rest }) => rest)
  return { query, terms, scanned: pages.length, partial, results }
}

/**
 * Pages that already cover the same topic: same file slug, or the same
 * declared title. Used to tell the writer 「改旧页」 instead of adding a twin.
 * @param {string} memoryDir
 * @param {{ relPath: string, title?: string }} page
 * @returns {Array<{ path: string, title: string }>}
 */
export function findSameTopicPages(memoryDir, page) {
  const rel = normalizeIndexPath(page.relPath)
  const slug = basename(rel, '.md').toLowerCase()
  const wantedTitle = (page.title ?? '').trim().toLowerCase()
  const matches = []
  for (const other of listPages(memoryDir, { includeRaw: true })) {
    if (other === rel) continue
    const otherSlug = basename(other, '.md').toLowerCase()
    if (otherSlug === slug) {
      matches.push({ path: other, title: slug })
      continue
    }
    if (wantedTitle.length === 0) continue
    try {
      const { title } = describeMemoryPage(readFileSync(join(memoryDir, other), 'utf8'), other)
      if (title.trim().toLowerCase() === wantedTitle) matches.push({ path: other, title })
    } catch {
      // unreadable page: not a dedup signal
    }
  }
  return matches
}

/**
 * Write one page and keep the catalog (plus the derived hot subset, when the
 * store still carries one) in sync.
 *
 * @param {string} memoryDir absolute store path
 * @param {{
 *   path: string, content: string, ifVersion?: string, allowDuplicate?: boolean,
 *   summary?: string, salience?: number, logEntry?: string, now?: Date,
 * }} options
 * @returns {object} write report
 */
export function writeMemoryPage(memoryDir, options) {
  const root = resolve(memoryDir)
  const { absolute, relative: rel, realRelative } = resolveInside(root, options.path)
  if (!rel.endsWith('.md')) throw new MemoryOperationError('NOT_A_PAGE', `${rel} 不是 markdown 页面（必须以 .md 结尾）`)
  assertNotRaw(rel, realRelative)
  if (ENGINE_OWNED_FILES.has(rel)) {
    throw new MemoryOperationError(
      'INVALID',
      `${rel} 由插件维护（目录行/派生文件/时间线），不能整份改写：页面写普通 .md，时间线用 logEntry 追加`,
    )
  }
  const content = String(options.content ?? '')
  if (content.trim().length === 0) throw new MemoryOperationError('INVALID', 'content 不能为空')

  const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
  const currentVersion = existing === undefined ? undefined : pageVersion(existing)
  if (existing === undefined && options.ifVersion !== undefined) {
    throw new MemoryOperationError('CONFLICT', `${rel} 不存在，无法匹配 ifVersion=${options.ifVersion}；新建页面请省略 ifVersion`, { currentVersion: null })
  }
  if (existing !== undefined && options.ifVersion === undefined) {
    throw new MemoryOperationError(
      'CONFLICT',
      `${rel} 已存在（version ${currentVersion}）：改旧页请先 memory_read 再带 ifVersion=${currentVersion} 写回；确实要新建请换一个路径`,
      { currentVersion },
    )
  }
  if (existing !== undefined && options.ifVersion !== currentVersion) {
    throw new MemoryOperationError(
      'CONFLICT',
      `${rel} 已被改动（当前 version ${currentVersion}，你基于 ${options.ifVersion}）：请重新 memory_read 后再写`,
      { currentVersion },
    )
  }

  const meta = describeMemoryPage(content, rel)
  const duplicates = findSameTopicPages(root, { relPath: rel, title: meta.title })
  if (duplicates.length > 0 && options.allowDuplicate !== true) {
    throw new MemoryOperationError(
      'DUPLICATE',
      `同主题页已存在：${duplicates.map((entry) => entry.path).join('、')}。请改旧页（memory_read → 带 ifVersion 写回），确实要另建再传 allowDuplicate: true`,
      { candidates: duplicates },
    )
  }

  mkdirSync(dirname(absolute), { recursive: true })
  const temp = `${absolute}.tmp-${process.pid}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, absolute)

  const indexPath = join(root, INDEX_FILENAME)
  const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Memory Index\n\n> 内容目录：每个记忆页一行。\n'
  const row = upsertIndexRow(indexText, {
    path: rel,
    title: meta.title,
    summary: options.summary ?? meta.summary,
    salience: options.salience ?? meta.salience,
  })
  if (row.action !== 'unchanged') writeFileSync(indexPath, row.text, 'utf8')

  let bootSubset = 'skipped'
  const subsetPath = join(root, DERIVED_INDEX_FILENAME)
  if (existsSync(subsetPath)) {
    writeBootSubsetFile(root, row.text)
    bootSubset = 'regenerated'
  }

  let logged = false
  if (typeof options.logEntry === 'string' && options.logEntry.trim().length > 0) {
    logged = appendLogEntry(root, options.logEntry, options.now)
  }

  return {
    path: rel,
    action: existing === undefined ? 'created' : 'updated',
    version: pageVersion(content),
    previousVersion: currentVersion ?? null,
    indexRow: row.action,
    bootSubset,
    logged,
    salience: meta.salience,
    title: meta.title,
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}

/**
 * Rebuild the optional derived hot-subset file (`index.boot.md`). Stores that
 * carry one keep getting it refreshed after every write; stores that do not
 * are left alone (the derived subset is computed in-process at boot instead).
 *
 * @param {string} memoryDir
 * @param {string} [indexText] catalog contents (re-read when omitted)
 * @returns {string} the subset text
 */
export function writeBootSubsetFile(memoryDir, indexText) {
  const root = resolve(memoryDir)
  const source = indexText ?? readFileSync(join(root, INDEX_FILENAME), 'utf8')
  const subset = deriveIndexSubset(source, { salience: HOT_SALIENCE })
  const header = '# Memory Index — boot 子集（salience=1）\n\n'
    + '> 一行一条；**全量表见 index.md**（按需 read）。本文件为派生物，由 @log.li/dsh-memory 在写入记忆后重生成，勿手改。\n\n'
  writeFileSync(join(root, DERIVED_INDEX_FILENAME), `${header}${subset.text}`, 'utf8')
  return subset.text
}

/**
 * Append one timeline entry to `log.md` in the store's own format
 * (`## [YYYY-MM-DD] <kind> | <title>`).
 * @param {string} memoryDir
 * @param {string} entry
 * @param {Date} [now]
 * @returns {boolean} whether the log was written
 */
export function appendLogEntry(memoryDir, entry, now = new Date()) {
  const root = resolve(memoryDir)
  const logPath = join(root, 'log.md')
  const line = entry.trim().replace(/^##\s*/, '')
  const dated = /^\[/.test(line) ? line : `[${localDate(now)}] ${line}`
  let prefix = ''
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, 'utf8')
    prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  }
  appendFileSync(logPath, `${prefix}## ${dated}\n`, 'utf8')
  return true
}

/** Local calendar date, `YYYY-MM-DD`. */
export function localDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
