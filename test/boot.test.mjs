import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BOOT_FILES, renderBootBlock, renderBootParts } from '../lib/boot.js'

const INDEX = `# Memory Index\n\n_（暂无）_\n`

/** Build a throwaway store with the given files (name -> content). */
function makeStore(files) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-boot-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}

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
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
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
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
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
    'MEMORY.md': '# MEMORY\n',
    'index.md': '# Memory Index\n\n- [只有一页](note.md) — 摘要\n',
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
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'index.boot.md': '# 过时的外置派生文件\n\n- [旧](stale.md)\n',
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
    'MEMORY.md': '# MEMORY\n',
    'index.md': `# Memory Index\n\n## decisions（决策）\n\n${rows.join('\n')}\n`,
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
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
    'log.md': '## [2026-09-23] decision | 一条\n',
  })
  try {
    const parts = renderBootParts(dir, { bootFiles: DEFAULT_BOOT_FILES })
    assert.deepEqual(parts.parts.map((part) => part.id), ['header', 'MEMORY.md', 'index.md', 'log.md'])
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

test('persona files are ordinary pages: a present SOUL.md is never injected by default', () => {
  const dir = makeStore({
    'SOUL.md': '# SOUL — 人格与灵魂\n\n- **名字**：小蓝。\n',
    'BOOTSTRAP.md': '---\nstatus: pending\n---\n\n# BOOTSTRAP\n',
    'MEMORY.md': '# MEMORY\n',
    'index.md': CATALOG,
  })
  try {
    assert.deepEqual(DEFAULT_BOOT_FILES, ['MEMORY.md', 'index.md'])
    const parts = renderBootParts(dir, {})
    assert.deepEqual(parts.parts.map((part) => part.id), ['header', 'MEMORY.md', 'index.md'])
    assert.ok(!parts.parts.some((part) => part.id === 'soul-directive'), 'no soul directive exists any more')
    assert.ok(!parts.text.includes('小蓝'), 'a persona file is not resident')
    assert.ok(!parts.text.includes('人格与灵魂'), 'no persona narration')
    assert.ok(!parts.text.includes('首要任务'), 'no first-task instruction')
    // …but a deployment may still list it explicitly (it is just a page then).
    const explicit = renderBootParts(dir, { bootFiles: ['SOUL.md', 'MEMORY.md'] })
    assert.deepEqual(explicit.parts.map((part) => part.id), ['header', 'SOUL.md', 'MEMORY.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the injected header promises only what exists now (no persona, no reminder)', () => {
  const dir = makeStore({ 'MEMORY.md': '# MEMORY\n', 'index.md': CATALOG })
  try {
    const block = renderBootBlock(dir, {})
    // v0.8.0 removed the digest reminder: the header must not announce it.
    assert.ok(!block.includes('digest 提醒'), 'no promise of a removed reminder')
    assert.ok(!block.includes('人格'), 'no persona framing')
    assert.ok(!block.includes('不得拖延'), 'no nagging tone')
    // What it must still say: where the store is, that the index is partial,
    // and that writing back at session end is the model's own duty.
    assert.match(block, /记忆库位于/)
    assert.match(block, /按需取/)
    assert.match(block, /无新增/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
