import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MEMORY_TOOL_NAMES, createMemoryTools, registerMemoryTools, renderSearchResult, renderWriteResult } from '../lib/tools.js'
import { auditSchema, validateValue } from '../lib/tool-schema.js'
import { MemoryOperationError, pageVersion, resolveInside } from '../lib/pages.js'

test('definitions stay inside the host JSON-Schema subset', () => {
  const definitions = createMemoryTools({ getMemoryDir: () => '/tmp' })
  assert.deepEqual(definitions.map((definition) => definition.name), MEMORY_TOOL_NAMES)
  for (const definition of definitions) {
    assert.deepEqual(auditSchema(definition.parameters, `${definition.name}.parameters`), [])
    assert.deepEqual(auditSchema(definition.output.schema, `${definition.name}.output`), [])
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    // The model sees only name/description/parameters.
    assert.ok(definition.description.length > 40)
  }
})

test('registerMemoryTools registers and disposes every tool', () => {
  const registered = []
  const disposed = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => disposed.push(definition.name)
      },
    },
  }
  const dispose = registerMemoryTools(ctx, { getMemoryDir: () => '/tmp' })
  assert.deepEqual(registered, MEMORY_TOOL_NAMES)
  dispose()
  assert.deepEqual(disposed, [...MEMORY_TOOL_NAMES].reverse())
})

test('arguments are validated before the body runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-args-'))
  try {
    const [search, read, write] = createMemoryTools({ getMemoryDir: () => dir })
    await assert.rejects(() => search.execute({}, {}), /invalid arguments: missing required property "query"/)
    await assert.rejects(() => search.execute({ query: 'x', limit: 'many' }, {}), /must be an integer/)
    await assert.rejects(() => search.execute({ query: 'x', oops: 1 }, {}), /unexpected property "oops"/)
    await assert.rejects(() => read.execute(undefined, {}), /invalid arguments/)
    await assert.rejects(() => write.execute({ path: 'a.md' }, {}), /missing required property "content"/)
    await assert.rejects(() => write.execute({ path: 'a.md', content: 'x', salience: 9 }, {}), /must be one of/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search finds pages by title, path and body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-search-'))
  try {
    writeFileSync(join(dir, 'index.md'), '# Memory Index\n')
    writeFileSync(join(dir, 'decisions.md'), '# 索引分层决策\n\n常驻上下文只放热页索引，正文按需取。\n')
    writeFileSync(join(dir, 'user.md'), '# 用户偏好\n\n直引号改弯引号。\n')
    writeFileSync(join(dir, 'log.md'), '## [2026-09-23] decision | 索引分层\n')

    const [search] = createMemoryTools({ getMemoryDir: () => dir })
    const value = await search.execute({ query: '热页索引' }, {})
    assert.equal(value.results.length, 1)
    assert.equal(value.results[0].path, 'decisions.md')
    assert.ok(value.results[0].matches.length > 0)
    assert.equal(validateValue(search.output.schema, value).length, 0, 'canonical value matches the declared output schema')
    assert.match(search.output.render({}, value)[0].text, /命中 1 页/)

    // log.md is excluded by default and included on request.
    const withoutLog = await search.execute({ query: '索引分层' }, {})
    assert.deepEqual(withoutLog.results.map((entry) => entry.path), ['decisions.md'])
    const withLog = await search.execute({ query: '索引分层', includeLog: true }, {})
    assert.ok(withLog.results.some((entry) => entry.path === 'log.md'))

    // No hit at all is reported as such, never as silence.
    const none = await search.execute({ query: '不存在的主题词xyz' }, {})
    assert.deepEqual(none.results, [])
    assert.equal(none.partial, false)
    assert.match(renderSearchResult(none), /无命中/)

    // Partial matches are flagged so the model widens instead of giving up.
    const partial = await search.execute({ query: '热页 弯引号' }, {})
    assert.equal(partial.partial, true)
    assert.equal(partial.results.length, 2)
    assert.match(renderSearchResult(partial), /部分命中/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read returns the body, the version and the page metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-read-'))
  try {
    const page = '---\ntitle: 注入分层\nsalience: 1\n---\n\n# 注入分层\n\n常驻只放热页。\n'
    writeFileSync(join(dir, 'page.md'), page)
    const [, read] = createMemoryTools({ getMemoryDir: () => dir })

    const value = await read.execute({ path: 'page.md' }, {})
    assert.equal(value.text, page)
    assert.equal(value.version, pageVersion(page))
    assert.equal(value.title, '注入分层')
    assert.equal(value.salience, 1)
    assert.equal(validateValue(read.output.schema, value).length, 0)

    await assert.rejects(() => read.execute({ path: 'missing.md' }, {}), /NOT_FOUND/)
    await assert.rejects(() => read.execute({ path: '../../etc/passwd' }, {}), /OUT_OF_STORE/)
    await assert.rejects(() => read.execute({ path: 'notes.txt' }, {}), /NOT_A_PAGE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write creates a page, files the catalog row, logs and commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-write-'))
  try {
    writeFileSync(join(dir, 'index.md'), '# Memory Index\n\n## decisions（决策）\n\n- [旧决策](decisions/old.md) — 旧（salience 2）\n')
    const commits = []
    const tools = createMemoryTools({
      getMemoryDir: () => dir,
      triggerCommit: () => {
        commits.push(Date.now())
        return 'committed'
      },
    })
    const write = tools[2]

    const created = await write.execute({
      path: 'decisions/new-decision.md',
      content: '---\ntitle: 新决策\nsalience: 1\n---\n\n# 新决策\n\n决定不换插件，只改注入层。\n',
      logEntry: 'decision | 决定不换插件',
    }, {})
    assert.equal(created.action, 'created')
    assert.equal(created.previousVersion, null)
    assert.equal(created.indexRow, 'inserted')
    assert.equal(created.logged, true)
    assert.equal(created.autocommit, 'committed')
    assert.equal(commits.length, 1)
    assert.equal(validateValue(write.output.schema, created).length, 0)

    const index = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.match(index, /- \[新决策\]\(decisions\/new-decision\.md\) — 决定不换插件，只改注入层。（salience 1）/)
    assert.match(index, /- \[旧决策\]\(decisions\/old\.md\) — 旧（salience 2）/, 'other rows are untouched')
    const log = readFileSync(join(dir, 'log.md'), 'utf8')
    assert.match(log, /^## \[\d{4}-\d{2}-\d{2}\] decision \| 决定不换插件\n/)

    // Rewriting without ifVersion is refused (the model must read first).
    await assert.rejects(
      () => write.execute({ path: 'decisions/new-decision.md', content: '# x\n' }, {}),
      /CONFLICT: decisions\/new-decision\.md 已存在/,
    )
    // A stale version is refused too.
    await assert.rejects(
      () => write.execute({ path: 'decisions/new-decision.md', content: '# x\n', ifVersion: 'deadbeef0000' }, {}),
      /CONFLICT: decisions\/new-decision\.md 已被改动/,
    )
    // The version handed out by memory_read is accepted, and the row is replaced.
    const [, read] = tools
    const page = await read.execute({ path: 'decisions/new-decision.md' }, {})
    const updated = await write.execute({
      path: 'decisions/new-decision.md',
      content: '---\ntitle: 新决策\nsalience: 1\n---\n\n# 新决策\n\n改主意了：连索引一起重建。\n',
      ifVersion: page.version,
    }, {})
    assert.equal(updated.action, 'updated')
    assert.equal(updated.previousVersion, page.version)
    assert.equal(updated.indexRow, 'replaced')
    assert.notEqual(updated.version, page.version)
    assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /连索引一起重建。（salience 1）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write refuses twins, raw/ and non-markdown paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-refuse-'))
  try {
    writeFileSync(join(dir, 'index.md'), '# Memory Index\n')
    mkdirSync(join(dir, 'identity'), { recursive: true })
    mkdirSync(join(dir, 'raw'), { recursive: true })
    writeFileSync(join(dir, 'identity', 'topic.md'), '# 主题\n\n正文\n')
    writeFileSync(join(dir, 'raw', 'source.md'), '# 源材料\n')

    const write = createMemoryTools({ getMemoryDir: () => dir })[2]
    await assert.rejects(
      () => write.execute({ path: 'skills/topic.md', content: '# 主题\n\n另一份\n' }, {}),
      /DUPLICATE: 同主题页已存在：identity\/topic\.md/,
    )
    const allowed = await write.execute({ path: 'skills/topic.md', content: '# 主题\n\n另一份\n', allowDuplicate: true }, {})
    assert.equal(allowed.action, 'created')
    await assert.rejects(
      () => write.execute({ path: 'raw/new.md', content: '# x\n' }, {}),
      /RAW_READONLY/,
    )
    await assert.rejects(
      () => write.execute({ path: 'notes.txt', content: 'x' }, {}),
      /NOT_A_PAGE/,
    )
    await assert.rejects(
      () => write.execute({ path: 'empty.md', content: '   ' }, {}),
      /INVALID/,
    )
    await assert.rejects(
      () => write.execute({ path: '../outside.md', content: '# x\n' }, {}),
      /OUT_OF_STORE/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write regenerates the derived hot subset when the store carries one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-subset-'))
  try {
    writeFileSync(join(dir, 'index.md'), '# Memory Index\n\n## decisions（决策）\n')
    writeFileSync(join(dir, 'index.boot.md'), '# Memory Index — boot 子集（salience=1）\n\n')
    const write = createMemoryTools({ getMemoryDir: () => dir })[2]
    const report = await write.execute({
      path: 'decisions/hot.md',
      content: '---\ntitle: 热决策\nsalience: 1\n---\n\n# 热决策\n\n热页正文。\n',
    }, {})
    assert.equal(report.bootSubset, 'regenerated')
    const subset = readFileSync(join(dir, 'index.boot.md'), 'utf8')
    assert.match(subset, /decisions\/hot\.md/)

    // A store without the derived file is left without one.
    const other = mkdtempSync(join(tmpdir(), 'memory-tools-subset-off-'))
    writeFileSync(join(other, 'index.md'), '# Memory Index\n')
    const second = await createMemoryTools({ getMemoryDir: () => other })[2].execute({ path: 'a.md', content: '# A\n\n正文\n' }, {})
    assert.equal(second.bootSubset, 'skipped')
    assert.equal(existsSync(join(other, 'index.boot.md')), false)
    rmSync(other, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('render helpers keep the write report and the search hits readable', () => {
  const text = renderWriteResult({
    path: 'a.md',
    action: 'updated',
    version: 'aaa',
    previousVersion: 'bbb',
    indexRow: 'replaced',
    bootSubset: 'skipped',
    logged: false,
    autocommit: 'clean',
  })
  assert.match(text, /已更新 a\.md/)
  assert.match(text, /原 bbb/)
  assert.match(text, /index\.md：replaced/)
})

test('resolveInside and pageVersion behave as the write protocol assumes', async () => {
  assert.deepEqual(resolveInside('/store', './a/b.md'), { absolute: '/store/a/b.md', relative: 'a/b.md', realRelative: 'a/b.md' })

  // Symlinks are resolved: a link out of the store (or onto raw/) is refused.
  const store = mkdtempSync(join(tmpdir(), 'memory-tools-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'memory-tools-outside-'))
  try {
    mkdirSync(join(store, 'raw'), { recursive: true })
    symlinkSync(outside, join(store, 'escape-dir'))
    symlinkSync('/etc/hosts', join(store, 'escape-file.md'))
    symlinkSync(join(store, 'raw'), join(store, 'raw-link'))
    symlinkSync(join(store, 'MEMORY.md'), join(store, 'inner-link.md'))
    writeFileSync(join(store, 'MEMORY.md'), '# MEMORY\n')

    assert.equal(resolveInside(store, 'file.md').realRelative, 'file.md')
    assert.equal(resolveInside(store, 'inner-link.md').realRelative, 'MEMORY.md')
    assert.throws(() => resolveInside(store, 'escape-dir/x.md'), (error) => error.code === 'OUT_OF_STORE')
    assert.throws(() => resolveInside(store, 'escape-file.md'), (error) => error.code === 'OUT_OF_STORE')
    const write = createMemoryTools({ getMemoryDir: () => store })[2]
    await assert.rejects(() => write.execute({ path: 'escape-dir/x.md', content: '# x\n' }, {}), /OUT_OF_STORE/)
    await assert.rejects(() => write.execute({ path: 'raw-link/x.md', content: '# x\n' }, {}), /RAW_READONLY/)
    assert.equal(existsSync(join(outside, 'x.md')), false, 'nothing escaped the store')
  } finally {
    rmSync(store, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
  assert.throws(() => resolveInside('/store', '/store'), MemoryOperationError)
  assert.throws(() => resolveInside('/store', '..'), MemoryOperationError)
  assert.throws(() => resolveInside('/store', '   '), MemoryOperationError)
  assert.equal(pageVersion('same'), pageVersion('same'))
  assert.notEqual(pageVersion('same'), pageVersion('other'))
  assert.equal(pageVersion('same').length, 12)
})

test('a second store target is honoured on every call', async () => {
  const first = mkdtempSync(join(tmpdir(), 'memory-tools-a-'))
  const second = mkdtempSync(join(tmpdir(), 'memory-tools-b-'))
  try {
    writeFileSync(join(first, 'index.md'), '# A\n')
    writeFileSync(join(second, 'index.md'), '# B\n')
    let current = first
    const write = createMemoryTools({ getMemoryDir: () => current })[2]
    await write.execute({ path: 'x.md', content: '# X\n\n正文\n' }, {})
    current = second
    const report = await write.execute({ path: 'x.md', content: '# X\n\n正文\n' }, {})
    assert.equal(report.action, 'created', 'the same path is a fresh page in the other store')
    assert.equal(existsSync(join(second, 'x.md')), true)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
