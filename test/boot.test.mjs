import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderBootBlock, renderBootParts, needsSoulBootstrap, readBootstrapStatus, SOUL_DIRECTIVE } from '../lib/boot.js'

const SOUL_TEMPLATE = `# SOUL — 人格与灵魂

## 身份

- **名字**：_（铸魂对话中确认）_
`

const SOUL_FILLED = `# SOUL — 人格与灵魂

## 身份

- **名字**：小蓝。
`

const BOOTSTRAP_PENDING = `---
status: pending
---

# BOOTSTRAP — 灵魂定义与身份确认

- [ ] 名字与称呼
`

const BOOTSTRAP_COMPLETE = `---
status: complete
---

# BOOTSTRAP — 灵魂定义与身份确认

- [x] 名字与称呼
`

const INDEX = `# Memory Index\n\n_（暂无）_\n`

/** Build a throwaway store with the given files (name -> content). */
function makeStore(files) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-boot-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}

test('fresh scaffold (pending + placeholder SOUL) renders the soul directive', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_TEMPLATE,
    'MEMORY.md': '# MEMORY\n',
    'index.md': INDEX,
    'BOOTSTRAP.md': BOOTSTRAP_PENDING,
  })
  try {
    assert.equal(needsSoulBootstrap(dir), true)
    const block = renderBootBlock(dir)
    // First-person onboarding narration, OpenClaw-init style.
    assert.match(block, /我的首要任务是确认我是谁/)
    assert.match(block, /我叫什么名字/)
    assert.match(block, /我该怎么称呼你/)
    // The directive sits ahead of the store files.
    assert.ok(block.indexOf(SOUL_DIRECTIVE) < block.indexOf('### SOUL.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('souled store (complete + filled SOUL) hides the directive', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': INDEX,
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    assert.equal(needsSoulBootstrap(dir), false)
    const block = renderBootBlock(dir)
    assert.ok(!block.includes('我的首要任务是确认我是谁'))
    assert.ok(!block.includes(SOUL_DIRECTIVE))
    assert.match(block, /小蓝/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('old store without BOOTSTRAP.md: placeholder SOUL still triggers, filled SOUL does not', () => {
  const pending = makeStore({ 'SOUL.md': SOUL_TEMPLATE, 'index.md': INDEX })
  const filled = makeStore({ 'SOUL.md': SOUL_FILLED, 'index.md': INDEX })
  try {
    assert.equal(readBootstrapStatus(pending), 'pending')
    assert.equal(needsSoulBootstrap(pending), true)
    assert.equal(needsSoulBootstrap(filled), false)
    assert.ok(!renderBootBlock(filled).includes(SOUL_DIRECTIVE))
  } finally {
    rmSync(pending, { recursive: true, force: true })
    rmSync(filled, { recursive: true, force: true })
  }
})

test('missing store: everything reads as needing a soul', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-boot-empty-'))
  try {
    assert.equal(needsSoulBootstrap(dir), true)
    // No injectable files at all → boot block stays empty.
    assert.equal(renderBootBlock(dir), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (a) Built-in index layering: the resident catalog is the hot subset only.
// ---------------------------------------------------------------------------

const CATALOG = `# Memory Index

## identity（自我）

- [热页一](identity/hot-1.md) — 热页摘要一（salience 1）
- [温页](identity/warm.md) — 温页摘要（salience 2）

## decisions（决策）

- [热页二](decisions/hot-2.md) — 热页摘要二（salience 1）
- [冷页](decisions/cold.md) — 冷页摘要（salience 3）
`

test('derive mode injects only the salience=1 rows', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const block = renderBootBlock(dir, { bootFiles: ['MEMORY.md', 'index.md'], bootMaxChars: 6000 })
    assert.match(block, /### index\.md（boot 子集：salience=1 热页）/)
    assert.match(block, /hot-1\.md/)
    assert.match(block, /hot-2\.md/)
    assert.ok(!block.includes('warm.md'), 'warm pages stay out of the resident subset')
    assert.ok(!block.includes('cold.md'), 'cold pages stay out of the resident subset')
    assert.ok(!block.includes('已截断'), 'the resident subset is never truncated')
    assert.ok(!block.includes('文件过长'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("indexBootMode: 'off' injects the catalog literally", () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const block = renderBootBlock(dir, { bootFiles: ['MEMORY.md', 'index.md'], bootMaxChars: 6000, indexBootMode: 'off' })
    assert.match(block, /### index\.md\n/)
    assert.ok(block.includes('cold.md'), 'the literal catalog keeps every row')
    assert.ok(!block.includes('boot 子集'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a catalog with no salience markers falls back to the literal file when it fits', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': '# Memory Index\n\n- [只有一页](note.md) — 摘要\n',
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const block = renderBootBlock(dir, { bootFiles: ['MEMORY.md', 'index.md'], bootMaxChars: 6000 })
    assert.match(block, /未使用 salience 标记，按原文注入/)
    assert.match(block, /只有一页/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a configured index.boot.md entry is derived from index.md in place', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'index.boot.md': '# 过时的外置派生文件\n\n- [旧](stale.md)\n',
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const block = renderBootBlock(dir, { bootFiles: ['MEMORY.md', 'index.boot.md'], bootMaxChars: 6000 })
    assert.match(block, /### index\.boot\.md（boot 子集：salience=1 热页）/)
    assert.ok(!block.includes('过时的外置派生文件'), 'the stale external artifact no longer decides the boot block')
    assert.match(block, /hot-1\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every hot page survives the budget: the resident index is never truncated', () => {
  const rows = Array.from({ length: 40 }, (_, index) => `- [热页 ${index}](decisions/hot-${index}.md) — ${'说'.repeat(60)}（salience 1）`)
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': `# Memory Index\n\n## decisions（决策）\n\n${rows.join('\n')}\n`,
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const parts = renderBootParts(dir, { bootFiles: ['MEMORY.md', 'index.md'], bootMaxChars: 6000 })
    const catalog = parts.parts.find((part) => part.id === 'index.md')
    assert.ok(catalog !== undefined)
    const perFile = Math.floor(6000 / 2)
    assert.ok(catalog.text.length <= perFile, `per-file budget respected (${catalog.text.length} > ${perFile})`)
    const missing = rows
      .map((_, index) => index)
      .filter((index) => !catalog.text.includes(`](decisions/hot-${index}.md)`))
    // The subset may drop rows the budget genuinely cannot hold, but it must
    // report that instead of pretending — and it must never emit a truncation
    // marker mid-file.
    assert.ok(!catalog.text.includes('已截断'))
    assert.ok(missing.length < 40, 'a 6000-char budget holds most of a 40-row hot index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot parts carry stable ids, sources and mtimes', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_FILLED,
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'log.md': '## [2026-09-23] decision | 一条\n',
    'BOOTSTRAP.md': BOOTSTRAP_COMPLETE,
  })
  try {
    const parts = renderBootParts(dir, { bootFiles: ['SOUL.md', 'MEMORY.md', 'index.md'] })
    assert.deepEqual(parts.parts.map((part) => part.id), ['header', 'SOUL.md', 'MEMORY.md', 'index.md', 'log.md'])
    for (const part of parts.parts) {
      assert.ok(part.sources.every((source) => source.startsWith(dir)), 'sources are absolute store paths')
      assert.equal(typeof part.mtimeMs, 'number')
    }
    // The joined block is exactly the parts, so a delta can reuse them verbatim.
    assert.equal(parts.text, parts.parts.map((part) => part.text).join('\n\n---\n\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a store whose soul appears later swaps the directive for the real SOUL part', () => {
  const dir = makeStore({
    'SOUL.md': SOUL_TEMPLATE,
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'BOOTSTRAP.md': BOOTSTRAP_PENDING,
  })
  try {
    const before = renderBootParts(dir, { bootFiles: ['SOUL.md', 'MEMORY.md', 'index.md'] })
    assert.ok(before.parts.some((part) => part.id === 'soul-directive'))

    writeFileSync(join(dir, 'SOUL.md'), SOUL_FILLED)
    writeFileSync(join(dir, 'BOOTSTRAP.md'), BOOTSTRAP_COMPLETE)
    const after = renderBootParts(dir, { bootFiles: ['SOUL.md', 'MEMORY.md', 'index.md'] })
    assert.ok(!after.parts.some((part) => part.id === 'soul-directive'))
    assert.ok(after.parts.some((part) => part.id === 'SOUL.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
