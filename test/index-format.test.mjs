import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildIndexRow,
  categoryOf,
  cleanSummary,
  deriveIndexSubset,
  parseIndexEntries,
  parseIndexRow,
  parseSalience,
  upsertIndexRow,
} from '../lib/index-format.js'

const CATALOG = `# Memory Index

> 说明行。

## 元记忆

- [SOUL.md](SOUL.md) — 人格与灵魂。

## identity（自我）

- [可查就先自证](identity/verify-before-answering.md) — 回答前先自查可查状态（salience 1）
- [冷页](identity/cold.md) — 很冷（salience 3）

## skills（程序性）

- [插件开发规则](skills/dsh-plugin-development.md) — 单注册路径；另一段补充（salience 1）
`

test('parseIndexRow reads title, path, summary and salience', () => {
  const entry = parseIndexRow('- [可查就先自证](identity/verify-before-answering.md) — 回答前先自查（salience 1）')
  assert.equal(entry.title, '可查就先自证')
  assert.equal(entry.path, 'identity/verify-before-answering.md')
  assert.equal(entry.salience, 1)
  assert.equal(entry.summary, '回答前先自查')
  // Non-rows and rows without a summary are handled.
  assert.equal(parseIndexRow('## identity'), undefined)
  const bare = parseIndexRow('- [x](x.md)')
  assert.equal(bare.salience, undefined)
  assert.equal(bare.summary, '')
})

test('salience and summary survive multi-segment tails', () => {
  assert.equal(parseSalience('摘要（salience 2） — 后半段（salience 2）'), 2)
  assert.equal(parseSalience('没有标记'), undefined)
  assert.equal(cleanSummary('摘要（salience 2） — 后半段'), '摘要；后半段')
})

test('parseIndexEntries keeps line numbers and order', () => {
  const entries = parseIndexEntries(CATALOG)
  assert.deepEqual(entries.map((entry) => entry.path), [
    'SOUL.md',
    'identity/verify-before-answering.md',
    'identity/cold.md',
    'skills/dsh-plugin-development.md',
  ])
  assert.equal(CATALOG.split('\n')[entries[1].line], '- [可查就先自证](identity/verify-before-answering.md) — 回答前先自查可查状态（salience 1）')
})

test('deriveIndexSubset keeps only salience=1 pages', () => {
  const subset = deriveIndexSubset(CATALOG)
  assert.equal(subset.total, 2)
  assert.equal(subset.kept, 2)
  assert.match(subset.text, /verify-before-answering/)
  assert.match(subset.text, /dsh-plugin-development/)
  assert.ok(!subset.text.includes('cold.md'), 'cold pages stay out of the resident subset')
  assert.match(subset.text, /单注册路径；另一段补充/)
})

test('deriveIndexSubset compresses long summaries and honors the budget', () => {
  const long = CATALOG + `- [超长](decisions/huge.md) — ${'字'.repeat(400)}（salience 1）\n`
  const subset = deriveIndexSubset(long, { maxChars: 200 })
  assert.ok(subset.text.length <= 200, `subset must fit the budget (got ${subset.text.length})`)
  assert.ok(subset.shortened + subset.dropped > 0, 'overflow is reported, never silent')
  const line = subset.text.split('\n').find((entry) => entry.includes('huge.md'))
  assert.ok(line === undefined || line.length <= 130, 'a kept row is clamped per-line')
})

test('deriveIndexSubset is empty when nothing is hot', () => {
  const subset = deriveIndexSubset('# Memory Index\n\n- [冷](cold.md) — x（salience 3）\n')
  assert.equal(subset.total, 0)
  assert.equal(subset.text, '')
})

test('upsertIndexRow replaces in place and keeps other lines byte-identical', () => {
  const before = CATALOG.split('\n')
  const result = upsertIndexRow(CATALOG, {
    path: 'identity/cold.md',
    title: '冷页',
    summary: '不再很冷（salience 2）',
    salience: 2,
  })
  assert.equal(result.action, 'replaced')
  const after = result.text.split('\n')
  assert.equal(after.length, before.length)
  const changed = after.findIndex((line) => line.includes('cold.md'))
  assert.equal(after[changed], '- [冷页](identity/cold.md) — 不再很冷（salience 2）')
  assert.deepEqual(
    after.filter((_, index) => index !== changed),
    before.filter((_, index) => index !== changed),
  )
})

test('upsertIndexRow reports no-op writes as unchanged', () => {
  const row = '- [冷页](identity/cold.md) — 不再很冷（salience 2）'
  const once = upsertIndexRow(CATALOG, { path: 'identity/cold.md', title: '冷页', summary: '不再很冷（salience 2）', salience: 2 })
  const twice = upsertIndexRow(once.text, { path: 'identity/cold.md', title: '冷页', summary: '不再很冷（salience 2）', salience: 2 })
  assert.equal(twice.action, 'unchanged')
  assert.ok(once.text.includes(row))
})

test('upsertIndexRow inserts a new page into its category section', () => {
  const result = upsertIndexRow(CATALOG, {
    path: 'skills/new-skill.md',
    title: '新技能',
    summary: '刚学的坑',
    salience: 2,
  })
  assert.equal(result.action, 'inserted')
  const lines = result.text.split('\n')
  const index = lines.findIndex((line) => line.includes('new-skill.md'))
  const heading = lines.lastIndexOf('## skills（程序性）', index)
  assert.ok(index > heading, 'the new row lands under the matching heading')
  assert.ok(heading > 0 && !lines.slice(heading + 1, index).some((line) => line.startsWith('## ')))
})

test('upsertIndexRow appends a section when the category is new', () => {
  const result = upsertIndexRow(CATALOG, { path: 'concepts/x.md', title: 'X', summary: 'y', salience: 2 })
  assert.equal(result.action, 'appended-section')
  assert.match(result.text, /\n## concepts\n\n- \[X\]\(concepts\/x\.md\) — y（salience 2）\n$/)
})

test('upsertIndexRow files root-level pages under the meta section', () => {
  const result = upsertIndexRow(CATALOG, { path: 'NOTES.md', title: '笔记', summary: '随手记', salience: 1 })
  assert.equal(result.action, 'inserted')
  const lines = result.text.split('\n')
  const index = lines.findIndex((line) => line.includes('NOTES.md'))
  assert.ok(index < lines.indexOf('## identity（自我）'), 'meta rows stay in the meta section')
})

test('buildIndexRow mirrors the upstream row format', () => {
  assert.equal(buildIndexRow({ path: 'a/b.md', title: 'T', summary: 'S', salience: 1 }), '- [T](a/b.md) — S（salience 1）')
  assert.equal(buildIndexRow({ path: 'a/b.md', title: 'T' }), '- [T](a/b.md)')
})

test('categoryOf maps paths to catalog sections', () => {
  assert.equal(categoryOf('identity/x.md'), 'identity')
  assert.equal(categoryOf('skills/deep/x.md'), 'skills')
  assert.equal(categoryOf('MEMORY.md'), '元记忆')
})

test('a new row is never filed under a heading that merely contains the category', () => {
  const catalog = `# Memory Index

## user（关于用户）

- [偏好](user/preferences.md) — 已有（salience 2）

## user-preferences-notes

- [别的段](other.md) — 不相干（salience 2）
`
  const result = upsertIndexRow(catalog, { path: 'user/routing.md', title: '路由', summary: '新页', salience: 1 })
  assert.equal(result.action, 'inserted')
  const lines = result.text.split('\n')
  const row = lines.findIndex((line) => line.includes('user/routing.md'))
  const proper = lines.indexOf('## user（关于用户）')
  const impostor = lines.indexOf('## user-preferences-notes')
  assert.ok(row > proper && row < impostor, 'the row lands in the real category section')
})
