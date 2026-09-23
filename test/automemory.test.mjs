import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AutoMemory,
  CLASSIFY_SYSTEM,
  EXTRACT_SYSTEM,
  classifyPrompt,
  collectStreamText,
  extractPrompt,
  parseJsonObject,
  readTranscript,
} from '../lib/automemory.js'

/** A store with a catalog and one page, so extraction can update or create. */
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-automemory-'))
  writeFileSync(join(dir, 'index.md'), '# Memory Index\n\n## decisions（决策）\n\n- [旧决策](decisions/old.md) — 摘要（salience 2）\n')
  writeFileSync(join(dir, 'log.md'), '## [2026-09-23] decision | 种子\n')
  return dir
}

/** A session surface with a couple of real turns. */
function makeSession(id = 's1', turns = 3) {
  const events = new Map()
  const surface = []
  let seq = 0
  const append = (event) => {
    const next = seq
    seq += 1
    events.set(next, { ...event, seq: next })
    surface.push(next)
    return next
  }
  for (let turn = 0; turn < turns; turn += 1) {
    append({
      type: 'user/message',
      time: Date.now(),
      data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `用户第 ${turn} 轮：请把索引分层的决定记下来，理由是常驻预算只有 5600 字符。` }], source: { kind: 'user' } },
    })
    append({
      type: 'assistant/message',
      time: Date.now(),
      data: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `助手第 ${turn} 轮：已按 salience=1 只放热页处理。` }], source: { kind: 'model', provider: 'p', model: 'm' } },
    })
  }
  return { id, surface: { nodes: surface }, eventAt: (value) => events.get(value) }
}

/** A scripted llm service: each call returns the next answer. */
function makeLlm(answers) {
  const requests = []
  return {
    requests,
    stream(options) {
      requests.push(options)
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)] ?? ''
      return (async function* stream() {
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
}

function makeAgent(dir, session, llm, config = {}) {
  const listeners = new Map()
  const agent = {
    id: 'agent-1',
    session,
    options: { provider: 'route-provider', model: 'route-model' },
    ctx: {
      get: (name) => (name === 'llm' ? llm : undefined),
      on: (name, listener) => {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
  }
  const instance = new AutoMemory(agent, {
    readConfig: () => ({
      enabled: true,
      autoMemory: true,
      autoMemoryMaxPerSession: 2,
      autoMemoryMinTurnsBetweenRuns: 1,
      autoMemoryMinTranscriptChars: 100,
      autoMemoryMaxPages: 3,
      ...config,
    }),
    getMemoryDir: () => dir,
    isPaused: () => config.paused === true,
    isRoot: () => config.active !== false,
    logger: { info() {}, warn() {} },
  })
  instance.start()
  const startTurn = () => listeners.get('session/event')?.(session, { type: 'turn/start' })
  // One turn has already happened (the boundary automemory runs at).
  startTurn()
  return { instance, listeners, startTurn }
}

test('stream text collection and JSON extraction tolerate chatty models', async () => {
  const collected = await collectStreamText((async function* generate() {
    yield { type: 'text-delta', index: 0, text: '{"remember"' }
    yield { type: 'text-delta', index: 0, text: ': false}' }
    yield { type: 'finish', reason: 'stop' }
  })())
  assert.equal(collected.text, '{"remember": false}')
  assert.equal(collected.finish, 'stop')

  assert.deepEqual(parseJsonObject('好的：\n```json\n{"remember":true,"topics":["a"]}\n```'), { remember: true, topics: ['a'] })
  assert.deepEqual(parseJsonObject('{"nested":{"a":"}"},"b":1}，后略'), { nested: { a: '}' }, b: 1 })
  assert.equal(parseJsonObject('没有 JSON'), undefined)
  assert.equal(parseJsonObject('{ 坏的'), undefined)
  assert.equal(parseJsonObject('[1,2]'), undefined)
})

test('the transcript carries real user and assistant turns, bounded', () => {
  const transcript = readTranscript(makeSession('t', 2), { maxChars: 5000 })
  assert.match(transcript, /用户：用户第 0 轮/)
  assert.match(transcript, /助手：助手第 1 轮/)
  assert.ok(!transcript.includes('memory-boot'))

  const clipped = readTranscript(makeSession('t2', 6), { maxChars: 300 })
  assert.ok(clipped.length < 500)
  assert.match(clipped, /较早内容已省略/)
})

test('prompts keep their framing and content', () => {
  assert.match(classifyPrompt('TRANSCRIPT'), /值得写入长期记忆/)
  assert.match(classifyPrompt('TRANSCRIPT'), /TRANSCRIPT/)
  assert.match(extractPrompt('TRANSCRIPT', 'CATALOG'), /index\.md/)
  assert.match(extractPrompt('TRANSCRIPT', 'CATALOG'), /CATALOG/)
  assert.match(CLASSIFY_SYSTEM, /remember/)
  assert.match(EXTRACT_SYSTEM, /pages/)
})

test('off by default: no model call at all', async () => {
  const dir = makeStore()
  try {
    const llm = makeLlm(['{"remember":false}'])
    const { instance } = makeAgent(dir, makeSession(), llm, { autoMemory: false })
    const report = await instance.maybeRun()
    assert.equal(report, undefined)
    assert.equal(llm.requests.length, 0)
    assert.equal(instance.eligibility().reason, 'automemory off')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a classifier "no" stops before any write', async () => {
  const dir = makeStore()
  try {
    const llm = makeLlm(['{"remember":false,"reason":"闲聊"}'])
    const { instance, startTurn } = makeAgent(dir, makeSession(), llm)
    const reports = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      startTurn()
      reports.push(await instance.maybeRun())
    }
    assert.equal(reports[0].reason, '闲聊')
    assert.equal(reports[0].remembered, false)
    assert.equal(reports[2], undefined, 'the per-session cap stops the third attempt')
    assert.equal(llm.requests.length, 2, 'one classify call per eligible run, no extract call')
    assert.match(llm.requests[0].system, /值得写入长期记忆/)
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8').includes('闲聊'), false)
    const log = readFileSync(join(dir, 'log.md'), 'utf8')
    assert.equal(log.split('## [').length - 1, 1, 'no log entry was appended')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two stages write a page, file the catalog row and append the log', async () => {
  const dir = makeStore()
  try {
    const plan = {
      pages: [{ path: 'decisions/index-layering.md', content: '---\ntitle: 索引分层\nsalience: 1\n---\n\n# 索引分层\n\n常驻只放热页。\n', summary: '常驻只放热页', salience: 1 }],
      logEntry: 'decision | 索引分层落地',
    }
    const llm = makeLlm(['{"remember":true,"reason":"有决策"}', JSON.stringify(plan)])
    const { instance } = makeAgent(dir, makeSession(), llm, { autoMemoryMinTurnsBetweenRuns: 1 })
    const report = await instance.maybeRun()

    assert.equal(report.wrote, 1)
    assert.deepEqual(report.paths, ['decisions/index-layering.md'])
    assert.equal(llm.requests.length, 2)
    // Stage 2 sees the transcript *and* the current catalog.
    assert.match(llm.requests[1].messages[0].content[0].text, /当前目录/)
    assert.match(llm.requests[1].messages[0].content[0].text, /旧决策/)
    assert.equal(llm.requests[0].provider, 'route-provider')
    assert.equal(llm.requests[0].model, 'route-model')

    const index = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.match(index, /- \[索引分层\]\(decisions\/index-layering\.md\) — 常驻只放热页（salience 1）/)
    assert.match(readFileSync(join(dir, 'log.md'), 'utf8'), /^## \[\d{4}-\d{2}-\d{2}\] decision \| 索引分层落地/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing page is updated through the version check, never blind-written', async () => {
  const dir = makeStore()
  try {
    const plan = { pages: [{ path: 'decisions/old.md', content: '---\ntitle: 旧决策\n---\n\n# 旧决策\n\n补上理由。\n', summary: '补上理由', salience: 2 }], logEntry: null }
    const llm = makeLlm(['{"remember":true}', JSON.stringify(plan)])
    const { instance } = makeAgent(dir, makeSession(), llm, { autoMemoryMinTurnsBetweenRuns: 1 })
    const report = await instance.maybeRun()
    // decisions/old.md only exists in the catalog, not on disk: creating it is
    // fine, and the catalog row is replaced rather than duplicated.
    assert.equal(report.wrote, 1)
    const index = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.equal(index.match(/decisions\/old\.md\)/g).length, 1)
    assert.match(index, /补上理由/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('guardrails: pause, session cap, turn spacing, root-session rule and the agent digest', async () => {
  const dir = makeStore()
  try {
    const llm = makeLlm(['{"remember":false}'])

    const paused = makeAgent(dir, makeSession('paused'), llm, { paused: true })
    assert.equal(paused.instance.eligibility().reason, 'paused for this session')

    const subagent = makeAgent(dir, makeSession('subagent'), llm, { active: false })
    assert.equal(subagent.instance.eligibility().reason, 'not a root session')

    const short = makeAgent(dir, makeSession('short', 1), llm)
    assert.equal(short.instance.eligibility().reason, 'transcript too small')

    // Turn spacing: the first run needs minTurnsBetweenRuns observed turns.
    const spaced = makeAgent(dir, makeSession('spaced', 3), llm, { autoMemoryMinTurnsBetweenRuns: 3 })
    assert.equal(spaced.instance.eligibility().reason, 'waiting for more turns')
    spaced.startTurn()
    spaced.startTurn()
    assert.equal(spaced.instance.eligibility().run, true)
    await spaced.instance.maybeRun()
    assert.equal(spaced.instance.eligibility().reason, 'waiting for more turns')

    // Session cap: two runs, then never again.
    for (let turn = 0; turn < 3; turn += 1) spaced.startTurn()
    await spaced.instance.maybeRun()
    for (let turn = 0; turn < 3; turn += 1) spaced.startTurn()
    assert.equal(spaced.instance.eligibility().reason, 'session cap reached')

    // The agent digested the store during this turn: its own judgement wins.
    const digested = makeAgent(dir, makeSession('digested', 3), llm, { autoMemoryMinTurnsBetweenRuns: 1 })
    writeFileSync(join(dir, 'log.md'), `${readFileSync(join(dir, 'log.md'), 'utf8')}## [2026-09-23] digest | 无新增\n`)
    assert.equal(digested.instance.eligibility().reason, 'store already written this turn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failures and bad model output are contained, never thrown', async () => {
  const dir = makeStore()
  try {
    const broken = {
      stream() {
        throw new Error('provider exploded')
      },
    }
    const { instance } = makeAgent(dir, makeSession('broken'), broken, { autoMemoryMinTurnsBetweenRuns: 1 })
    assert.equal(await instance.maybeRun(), undefined)

    // Unparseable extraction output writes nothing.
    const llm = makeLlm(['{"remember":true}', '我写不出来'])
    const second = makeAgent(dir, makeSession('nonsense'), llm, { autoMemoryMinTurnsBetweenRuns: 1 })
    const report = await second.instance.maybeRun()
    assert.equal(report.wrote, 0)

    // A path outside the store is refused by the write engine, not written.
    const escape = makeLlm(['{"remember":true}', JSON.stringify({ pages: [{ path: '../escape.md', content: '# x\n' }] })])
    const third = makeAgent(dir, makeSession('escape'), escape, { autoMemoryMinTurnsBetweenRuns: 1 })
    const thirdReport = await third.instance.maybeRun()
    assert.equal(thirdReport.wrote, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no llm service available is a skip, not a crash', async () => {
  const dir = makeStore()
  try {
    const { instance } = makeAgent(dir, makeSession(), undefined, { autoMemoryMinTurnsBetweenRuns: 1 })
    const report = await instance.maybeRun()
    assert.equal(report.wrote, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispose stops listening', () => {
  const dir = makeStore()
  try {
    const { instance, listeners } = makeAgent(dir, makeSession(), makeLlm(['{}']))
    assert.equal(listeners.size, 2)
    instance.dispose()
    assert.equal(listeners.size, 0)
    assert.equal(instance.eligibility().reason, 'disposed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unroutable run latches instead of retrying every turn', async () => {
  const dir = makeStore()
  try {
    const { instance, startTurn } = makeAgent(dir, makeSession(), undefined, { autoMemoryMinTurnsBetweenRuns: 1 })
    const first = await instance.maybeRun()
    assert.equal(first.called, 0)
    assert.equal(instance.unroutable, true, 'the configuration failure is latched')
    startTurn()
    assert.equal(instance.eligibility().reason, 'no model route available')
    // …and it recovers by itself once a route exists again.
    instance.options.llm = makeLlm(['{"remember":false}'])
    assert.equal(instance.eligibility().run, true)
    assert.equal(instance.unroutable, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing model call still consumes the session budget', async () => {
  const dir = makeStore()
  try {
    let calls = 0
    const flaky = {
      stream() {
        calls += 1
        throw new Error('provider exploded')
      },
    }
    const { instance, startTurn } = makeAgent(dir, makeSession(), flaky, { autoMemoryMinTurnsBetweenRuns: 1, autoMemoryMaxPerSession: 2 })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      startTurn()
      await instance.maybeRun()
    }
    assert.equal(instance.runs, 2, 'the cap bounds a broken provider')
    assert.equal(calls, 2)
    assert.equal(instance.eligibility().reason, 'session cap reached')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('page size, page count and duplicates are bounded', async () => {
  const dir = makeStore()
  try {
    // Oversized page is refused, the small one still lands.
    const big = { pages: [
      { path: 'decisions/huge.md', content: 'x'.repeat(13000) },
      { path: 'decisions/small.md', content: '---\ntitle: 小页\n---\n\n# 小页\n\n正文\n' },
    ] }
    const llm = makeLlm(['{"remember":true}', JSON.stringify(big)])
    const { instance } = makeAgent(dir, makeSession('big'), llm, { autoMemoryMinTurnsBetweenRuns: 1 })
    const report = await instance.maybeRun()
    assert.deepEqual(report.paths, ['decisions/small.md'])
    assert.equal(existsSync(join(dir, 'decisions', 'huge.md')), false)

    // maxPages truncates; a page whose subject already exists is skipped by the
    // engine's duplicate gate rather than written as a twin.
    writeFileSync(join(dir, 'decisions', 'twin.md'), '# 同主题\n\n已有页\n')
    const many = { pages: [
      { path: 'decisions/a.md', content: '# A\n\n正文\n' },
      { path: 'decisions/b.md', content: '# B\n\n正文\n' },
      { path: 'decisions/c.md', content: '# C\n\n正文\n' },
      { path: 'skills/twin.md', content: '# 同主题\n\n同主题另建\n' },
      { path: 'decisions/d.md', content: '# D\n\n正文\n' },
    ] }
    const second = makeLlm(['{"remember":true}', JSON.stringify(many)])
    const other = makeAgent(dir, makeSession('many'), second, { autoMemoryMinTurnsBetweenRuns: 1, autoMemoryMaxPages: 10 })
    const manyReport = await other.instance.maybeRun()
    assert.deepEqual(manyReport.paths, ['decisions/a.md', 'decisions/b.md', 'decisions/c.md', 'decisions/d.md'],
      "the twin is skipped by the engine's duplicate gate, not written twice")
    assert.equal(existsSync(join(dir, 'skills', 'twin.md')), false)

    // autoMemoryMaxPages caps how many of a model's pages may land at once.
    const capped = { pages: [
      { path: 'concepts/p1.md', content: '# P1\n\n正文\n' },
      { path: 'concepts/p2.md', content: '# P2\n\n正文\n' },
      { path: 'concepts/p3.md', content: '# P3\n\n正文\n' },
    ] }
    const third = makeLlm(['{"remember":true}', JSON.stringify(capped)])
    const limited = makeAgent(dir, makeSession('capped'), third, { autoMemoryMinTurnsBetweenRuns: 1, autoMemoryMaxPages: 2 })
    const cappedReport = await limited.instance.maybeRun()
    assert.equal(cappedReport.paths.length, 2, 'at most autoMemoryMaxPages pages land')
    assert.equal(existsSync(join(dir, 'concepts', 'p3.md')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
