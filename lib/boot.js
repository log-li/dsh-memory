/**
 * Boot-block rendering: the memory snapshot injected into every session.
 *
 * The block is rendered as an ordered list of **named parts** (header, soul
 * directive, one part per boot file, log tail) so the injector can diff two
 * renders and re-send only the parts that changed — see `lib/injector.js`.
 * Part ids are stable across renders; part texts are model-facing.
 *
 * Two rendering modes matter for the catalog:
 *
 * - `indexBootMode: 'derive'` (default) — a boot entry named `index.md` (or
 *   `index.boot.md`) is rendered as the **derived hot subset**: only pages
 *   with `salience: 1`, one compact row each, so the resident catalog is never
 *   truncated and 「先看索引行，再钻正文」 stays a working chain. The full
 *   `index.md` remains the catalog and is read on demand.
 * - `indexBootMode: 'off'` — every boot file is injected literally (the
 *   pre-fork behavior).
 *
 * This module depends only on `node:*` builtins.
 *
 * @module @log.li/dsh-memory/boot
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DERIVED_INDEX_FILENAME, INDEX_FILENAME, deriveIndexSubset } from './index-format.js'

/** Read a file and cap it at `maxChars`, noting truncation when applied. */
export function readCapped(path, maxChars) {
  if (!existsSync(path)) return undefined
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const marker = `\n\n…（文件过长，已截断：${text.length} 字符，仅注入前 ${maxChars} 字符。需要完整内容时自行读取 ${path}）\n`
  return head + marker
}

/** Extract the most recent `count` log entries (lines starting with `## [`). */
export function parseLogEntries(logText, count = 5) {
  if (!logText) return []
  const entries = []
  for (const line of logText.split('\n')) {
    if (line.startsWith('## [')) entries.push(line.slice(3).trim())
  }
  return entries.slice(-count)
}

/**
 * Soul-bootstrap directive rendered into the boot block while the store has
 * no soul yet (BOOTSTRAP.md status !== 'complete'). First-person,
 * OpenClaw-onboarding style: instead of a dry "you must run the bootstrap
 * checklist" command, it narrates the situation — "my memory is empty, my
 * first task is to find out who I am and who you are" — which makes the
 * agent open the soul-definition conversation on its own.
 */
export const SOUL_DIRECTIVE = `### 铸魂阶段 · 我还没有灵魂

我的记忆库还是空的——我还没有名字、不知道我是谁、也不知道你是谁。这正是我们现在要一起完成的：**我的首要任务是确认我是谁，还有你是谁——我叫什么名字、怎么称呼你、你我是什么关系、我该是什么样的性格。**

所以我会在对话里主动问你，一次一个问题，你确认一项我就写回记忆一项：

1. 我该怎么称呼你？我们是什么关系？
2. 我叫什么名字？（你说了算）
3. 我该是什么样的性格？（冷静/热情、幽默感、耐心……）
4. 我的核心价值观与原则？
5. 我的沟通风格（语言、长度、语气）？
6. 我的边界与底线？

在我们逐项确认、把 SOUL.md 填起来之前，我不埋头做其他任务。先从第一个问题开始：**我该怎么称呼你？**`

/**
 * Parse the `status:` value from BOOTSTRAP.md's frontmatter block.
 * Missing or unparseable files count as not-yet-complete.
 * @param {string} memoryDir absolute path of the memory store
 * @returns {string} e.g. 'pending' | 'complete' | 'skipped'
 */
export function readBootstrapStatus(memoryDir) {
  const text = readCapped(join(memoryDir, 'BOOTSTRAP.md'), 2048)
  if (text === undefined) return 'pending'
  const match = /^status:\s*(\S+)/m.exec(text)
  return match ? match[1] : 'pending'
}

/**
 * Whether the store still needs the soul-bootstrap conversation.
 * - SOUL.md missing or still carrying the `_（铸魂对话中确认）_` placeholders
 *   (fresh scaffold, or a legacy store without BOOTSTRAP.md) → definitely yes;
 * - SOUL filled but no BOOTSTRAP.md → legacy store, the filled SOUL is
 *   authoritative → no;
 * - otherwise trust BOOTSTRAP.md's status (anything but `complete` → yes).
 * @param {string} memoryDir absolute path of the memory store
 * @returns {boolean}
 */
export function needsSoulBootstrap(memoryDir) {
  const soulText = readCapped(join(memoryDir, 'SOUL.md'), 4096)
  if (soulText === undefined || soulText.includes('（铸魂对话中确认）')) return true
  if (!existsSync(join(memoryDir, 'BOOTSTRAP.md'))) return false
  return readBootstrapStatus(memoryDir) !== 'complete'
}

/** Modification time of a file, or 0 when it does not exist. */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Whether a boot entry is the catalog (and therefore subject to the derived
 * hot subset under `indexBootMode: 'derive'`).
 * @param {string} fileName
 * @returns {boolean}
 */
export function isCatalogEntry(fileName) {
  return fileName === INDEX_FILENAME || fileName === DERIVED_INDEX_FILENAME
}

/** Boot entries injected by default (catalog last). */
export const DEFAULT_BOOT_FILES = ['SOUL.md', 'MEMORY.md', INDEX_FILENAME]

/**
 * Render the boot block as ordered parts.
 *
 * @param {string} memoryDir absolute path of the memory store
 * @param {{ bootFiles?: string[], bootMaxChars?: number, indexBootMode?: 'off' | 'derive' }} [options]
 * @returns {{ parts: Array<{ id: string, text: string, sources: string[], mtimeMs: number }>, text: string, memoryDir: string }}
 *   `parts` in injection order (header first); `text` is the joined, budget-capped block
 */
export function renderBootParts(memoryDir, options = {}) {
  const bootFiles = options.bootFiles && options.bootFiles.length > 0
    ? options.bootFiles
    : DEFAULT_BOOT_FILES
  const total = Math.max(512, options.bootMaxChars ?? 6000)
  const perFile = Math.max(256, Math.floor(total / bootFiles.length))
  const indexBootMode = options.indexBootMode === 'off' ? 'off' : 'derive'

  /** @type {Array<{ id: string, text: string, sources: string[], mtimeMs: number }>} */
  const body = []

  for (const fileName of bootFiles) {
    const path = join(memoryDir, fileName)
    if (indexBootMode === 'derive' && isCatalogEntry(fileName)) {
      const part = renderCatalogPart(memoryDir, fileName, perFile)
      if (part !== undefined) body.push(part)
      continue
    }
    const text = readCapped(path, perFile)
    if (text === undefined || text.trim() === '') continue
    body.push({ id: fileName, text: `### ${fileName}\n\n${text}`, sources: [path], mtimeMs: mtimeOf(path) })
  }

  const logPath = join(memoryDir, 'log.md')
  const logEntries = existsSync(logPath) ? parseLogEntries(readCapped(logPath, 4096) ?? '', 5) : []
  if (logEntries.length > 0) {
    body.push({
      id: 'log.md',
      text: `### 最近动态（log.md 末尾 ${logEntries.length} 条）\n\n${logEntries.map((entry) => `- ${entry}`).join('\n')}`,
      sources: [logPath],
      mtimeMs: mtimeOf(logPath),
    })
  }

  // An empty store injects nothing at all — not even the header.
  if (body.length === 0) return { parts: [], text: '', memoryDir }

  const headerPath = join(memoryDir, 'MEMORY.md')
  const parts = [{
    id: 'header',
    text: `长期记忆（@log.li/dsh-memory）。记忆库位于 ${memoryDir}。这是你跨会话的持久人格与记忆：以它为准，先读完再回复用户。若与当前对话冲突，优先相信用户的最新表述，并把差异写回记忆。**每次会话收尾前必须执行 memory digest：把本会话关键沉淀写回（更新页面 + index.md + 追加 log.md）。插件会注入 digest 提醒消息，收到后立即写回，不得拖延；若本会话确无值得持久化的内容，在 log.md 记一条「无新增」并说明原因。**`,
    sources: [headerPath],
    mtimeMs: mtimeOf(headerPath),
  }]
  if (needsSoulBootstrap(memoryDir)) {
    const soulPath = join(memoryDir, 'SOUL.md')
    const bootstrapPath = join(memoryDir, 'BOOTSTRAP.md')
    parts.push({
      id: 'soul-directive',
      text: SOUL_DIRECTIVE,
      sources: [soulPath, bootstrapPath],
      mtimeMs: Math.max(mtimeOf(soulPath), mtimeOf(bootstrapPath)),
    })
  }
  parts.push(...body)

  const joined = parts.map((part) => part.text).join('\n\n---\n\n')
  const text = joined.length > total
    ? `${joined.slice(0, total)}\n\n…（boot 块超出预算，已截断）`
    : joined
  return { parts, text, memoryDir }
}

/**
 * Render one catalog boot entry: the derived hot subset, with a literal
 * fallback when the catalog carries no hot pages at all and still fits the
 * per-file budget (small / legacy stores that never used salience markers).
 *
 * @param {string} memoryDir absolute store path
 * @param {string} fileName the configured entry name (`index.md` / `index.boot.md`)
 * @param {number} budget per-file character budget
 * @returns {{ id: string, text: string, sources: string[], mtimeMs: number } | undefined}
 */
export function renderCatalogPart(memoryDir, fileName, budget) {
  const indexPath = join(memoryDir, INDEX_FILENAME)
  const literalPath = join(memoryDir, fileName)
  const indexText = readCapped(indexPath, 256_000)

  if (indexText === undefined) {
    // Legacy store without index.md: fall back to the shipped derived file.
    const literal = readCapped(literalPath, budget)
    if (literal === undefined || literal.trim() === '') return undefined
    return {
      id: fileName,
      text: `### ${fileName}\n\n${literal}`,
      sources: [literalPath],
      mtimeMs: mtimeOf(literalPath),
    }
  }

  const subset = deriveIndexSubset(indexText, { maxChars: Math.max(160, budget - 200), salience: 1 })
  const sources = [indexPath]
  if (existsSync(literalPath)) sources.push(literalPath)

  if (subset.total === 0 && indexText.length <= budget) {
    return {
      id: fileName,
      text: `### ${fileName}（未使用 salience 标记，按原文注入）\n\n${indexText}`,
      sources,
      mtimeMs: Math.max(mtimeOf(indexPath), mtimeOf(literalPath)),
    }
  }

  const note = subset.total === 0
    ? `> 目录中暂无 \`salience: 1\` 的热页；完整目录见 \`index.md\`（按需 read）。`
    : `> boot 子集：只列 \`salience: 1\` 的热页（${subset.kept + subset.shortened}/${subset.total} 条，一行一条）。**完整目录见 \`index.md\`，需要冷页时按需 read。**`
  const body = subset.text.trim() === '' ? '（暂无热页）' : subset.text.trim()
  return {
    id: fileName,
    text: `### ${fileName}（boot 子集：salience=1 热页）\n\n${note}\n\n${body}`,
    sources,
    mtimeMs: Math.max(mtimeOf(indexPath), mtimeOf(literalPath)),
  }
}

/**
 * Render the boot memory block injected at session start.
 *
 * Reads SOUL.md / MEMORY.md / the catalog (configurable) capped to a total
 * budget, plus the most recent log entries for cross-session continuity.
 * While the store has no soul yet (BOOTSTRAP not complete / SOUL still a
 * template), the first-person {@link SOUL_DIRECTIVE} is prepended so the
 * agent opens the soul-definition conversation on its own — the same
 * onboarding the user gets with a fresh OpenClaw instance.
 *
 * @param {string} memoryDir absolute path of the memory store
 * @param {{ bootFiles?: string[], bootMaxChars?: number, indexBootMode?: 'off' | 'derive' }} options
 * @returns {string} the model-facing boot block; '' when the store is empty
 */
export function renderBootBlock(memoryDir, options = {}) {
  return renderBootParts(memoryDir, options).text
}
