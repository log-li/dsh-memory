/**
 * `index.md` — the memory catalog: row parsing, the derived **boot subset**
 * (hot pages only), and the one-line row upsert used by `memory_write`.
 *
 * Data-plane compatibility is the hard constraint (see the project spec): the
 * full catalog stays exactly the upstream format — one
 * `- [title](path) — summary` row per page, grouped under `## <category>`
 * headings. Everything here is a *reader* of that format, plus the derived
 * hot subset, which is recomputed on demand and never becomes a second source
 * of truth.
 *
 * This module depends only on `node:*` builtins and is pure (no I/O).
 *
 * @module @log.li/dsh-memory/index-format
 */

/** The full catalog file (upstream format, never rewritten wholesale). */
export const INDEX_FILENAME = 'index.md'
/** Optional derived hot subset file (the pre-fork workaround; still honored). */
export const DERIVED_INDEX_FILENAME = 'index.boot.md'
/** `salience: 1` — the hot pages that belong in the resident boot subset. */
export const HOT_SALIENCE = 1
/** Default character budget of the derived boot subset. */
export const DEFAULT_SUBSET_CHARS = 2600
/** Default per-row summary width, in code points. */
export const DEFAULT_LINE_CHARS = 110

const ROW_RE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/
const SALIENCE_RE = /[（(]?\s*salience\s*[:=]?\s*([123])\s*[）)]?/i
const MARKER_RE = /[（(]\s*salience\s*[:=]?\s*[123]\s*[）)]|\bsalience\s*[:=]?\s*[123]\b/gi
const HEADING_RE = /^##\s+(.*)$/
/** Section heading that holds the meta files (SOUL/MEMORY/index/log). */
const META_SECTION_RE = /元记忆|meta|元数据/

/** @typedef {{ title: string, path: string, tail: string, summary: string, salience?: number }} IndexEntry */

/**
 * Parse one row line.
 * @param {string} line
 * @returns {IndexEntry | undefined} the entry, or undefined when the line is not a row
 */
export function parseIndexRow(line) {
  const match = ROW_RE.exec(line ?? '')
  if (!match) return undefined
  const [, title, path, tail] = match
  const trimmedTail = (tail ?? '').replace(/^[—–-]\s*/, '').trim()
  return {
    title: title.trim(),
    path: path.trim(),
    tail: trimmedTail,
    summary: cleanSummary(trimmedTail),
    salience: parseSalience(trimmedTail),
  }
}

/**
 * Read the salience marker out of a row tail.
 * @param {string} text
 * @returns {number | undefined} 1/2/3, or undefined when the tail carries no marker
 */
export function parseSalience(text) {
  const match = SALIENCE_RE.exec(text ?? '')
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Strip salience markers and collapse separators so a row tail reads as prose.
 * @param {string} text
 * @returns {string}
 */
export function cleanSummary(text) {
  return (text ?? '')
    .replace(MARKER_RE, ' ')
    .replace(/\s*[—–]\s*/g, '；')
    .replace(/\s+/g, ' ')
    .replace(/^[；\s]+|[；\s]+$/g, '')
    .trim()
}

/**
 * Parse every row in a catalog.
 * @param {string} indexText
 * @returns {Array<IndexEntry & { line: number }>}
 */
export function parseIndexEntries(indexText) {
  const entries = []
  const lines = (indexText ?? '').split('\n')
  for (let line = 0; line < lines.length; line += 1) {
    const entry = parseIndexRow(lines[line])
    if (entry !== undefined && entry.path.length > 0) entries.push({ ...entry, line })
  }
  return entries
}

/**
 * Truncate to a width measured in code points (CJK-safe).
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function clampText(text, maxChars) {
  const points = [...text]
  if (points.length <= maxChars) return text
  return `${points.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/** One catalog row, in upstream format. */
export function buildIndexRow({ path, title, summary, salience }) {
  const label = (title ?? '').trim() || (path ?? '').trim()
  const body = cleanSummary(summary ?? '')
  const marker = salience === undefined || salience === null ? '' : `（salience ${salience}）`
  const tail = body.length > 0 ? `${body}${marker}` : marker
  return tail.length > 0 ? `- [${label}](${path}) — ${tail}` : `- [${label}](${path})`
}

/**
 * Derive the resident boot subset: **only `salience = 1` pages**, one row
 * each, summaries compressed to fit a character budget. Rows that cannot fit
 * degrade to a title-plus-pointer line; whatever still does not fit is dropped
 * (the full catalog stays one `read` away).
 *
 * @param {string} indexText full `index.md` contents
 * @param {{ maxChars?: number, maxLineChars?: number, salience?: number }} [options]
 * @returns {{ text: string, total: number, kept: number, shortened: number, dropped: number }}
 */
export function deriveIndexSubset(indexText, options = {}) {
  const maxChars = Math.max(80, Number(options.maxChars) || DEFAULT_SUBSET_CHARS)
  const maxLineChars = Math.max(24, Number(options.maxLineChars) || DEFAULT_LINE_CHARS)
  const salience = options.salience ?? HOT_SALIENCE
  const hot = parseIndexEntries(indexText).filter((entry) => entry.salience === salience)

  const lines = []
  let used = 0
  let shortened = 0
  let dropped = 0
  for (const entry of hot) {
    const full = `- [${entry.title}](${entry.path}) — ${clampText(entry.summary, maxLineChars)}`
    if (used + full.length <= maxChars) {
      lines.push(full)
      used += full.length + 1
      continue
    }
    const short = `- [${entry.title}](${entry.path})`
    if (used + short.length <= maxChars) {
      lines.push(short)
      used += short.length + 1
      shortened += 1
      continue
    }
    dropped += 1
  }

  return {
    text: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    total: hot.length,
    kept: lines.length - shortened,
    shortened,
    dropped,
  }
}

/**
 * Insert or replace one page's row, leaving every other line byte-identical.
 * A replacement keeps the row's position (and therefore its section); a new
 * page is appended to the section that matches its category, or to a new
 * section when the catalog has none yet.
 *
 * @param {string} indexText current `index.md` contents
 * @param {{ path: string, title: string, summary?: string, salience?: number }} page
 * @returns {{ text: string, action: 'replaced' | 'inserted' | 'appended-section' | 'unchanged' }}
 */
export function upsertIndexRow(indexText, page) {
  const relPath = normalizeIndexPath(page.path)
  const row = buildIndexRow({ ...page, path: relPath })
  const text = indexText ?? ''
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const entry = parseIndexRow(lines[i])
    if (entry !== undefined && normalizeIndexPath(entry.path) === relPath) {
      if (lines[i] === row) return { text, action: 'unchanged' }
      lines[i] = row
      return { text: lines.join('\n'), action: 'replaced' }
    }
  }

  const category = categoryOf(relPath)
  const heading = findSectionHeading(lines, category)
  if (heading !== undefined) {
    const end = sectionEnd(lines, heading)
    const insertion = [...lines]
    const trailingBlank = end > heading + 1 && insertion[end - 1].trim() === ''
    if (trailingBlank) insertion.splice(end - 1, 0, row)
    else insertion.splice(end, 0, '', row)
    return { text: insertion.join('\n'), action: 'inserted' }
  }

  const suffix = text.endsWith('\n') ? '' : '\n'
  return { text: `${text}${suffix}\n## ${category}\n\n${row}\n`, action: 'appended-section' }
}

/**
 * Top-level category of a page path: its first directory, or the meta section
 * for a catalog-root file such as `MEMORY.md`.
 * @param {string} relPath
 * @returns {string}
 */
export function categoryOf(relPath) {
  const normalized = normalizeIndexPath(relPath)
  const separator = normalized.indexOf('/')
  if (separator < 0) return '元记忆'
  return normalized.slice(0, separator)
}

/** Catalog paths always use forward slashes. */
export function normalizeIndexPath(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Index of the `## <category>…` heading matching a category, if present.
 *
 * The match is on a word boundary — `## user（关于用户）` matches `user`, while
 * `## user-preferences` does not — so a new row can never be filed under a
 * heading that merely *contains* the category name.
 */
function findSectionHeading(lines, category) {
  const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = new RegExp(`^${escaped}(?![\\p{L}\\p{N}_-])`, 'iu')
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i])
    if (!match) continue
    const heading = match[1].trim()
    if (boundary.test(heading)) return i
    if (category === '元记忆' && META_SECTION_RE.test(heading)) return i
  }
  return undefined
}

/** First line index that ends the section starting at `heading`. */
function sectionEnd(lines, heading) {
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (HEADING_RE.test(lines[i])) return i
  }
  return lines.length
}
