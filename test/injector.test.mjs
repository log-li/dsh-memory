import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOOT_SECTION_NAME,
  BOOT_SECTION_PREFIX,
  BootInjector,
  DELTA_MARKER,
  NOTICE_SUMMARY_PREFIX,
  buildInjectionMessage,
  readOwnInjections,
} from '../lib/injector.js'

/** A store with a filled soul, a protocol file and a catalog with one hot page. */
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-inject-'))
  writeFileSync(join(dir, 'SOUL.md'), '# SOUL\n\n- **名字**：小蓝。\n')
  writeFileSync(join(dir, 'BOOTSTRAP.md'), '---\nstatus: complete\n---\n\n# BOOTSTRAP\n')
  writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v1。\n')
  writeFileSync(join(dir, 'index.md'), `# Memory Index

## identity

- [可查就先自证](identity/verify-before-answering.md) — 自查（salience 1）
`)
  writeFileSync(join(dir, 'log.md'), '## [2026-09-23] decision | 第一条\n')
  return dir
}

/**
 * A live-enough session: a surface of sequence numbers plus the events behind
 * them, with the host's own commit behavior (`append`) and compaction (`drop`).
 */
function makeSession(id = 's1') {
  const events = new Map()
  const surface = []
  let seq = 0
  return {
    id,
    surface: { nodes: surface },
    eventAt: (value) => events.get(value),
    append(message) {
      const next = seq
      seq += 1
      events.set(next, { type: 'user/message', data: message, time: Date.now() })
      surface.push(next)
      return next
    },
    /** Compaction: the events stay in the log, the model stops seeing them. */
    drop(seqs) {
      for (const value of seqs) {
        const index = surface.indexOf(value)
        if (index >= 0) surface.splice(index, 1)
      }
    },
    ownSeqs: () => [...surface],
  }
}

/** Drive one pre-step: the host commits whatever the decision carries. */
async function step(injector, session, agent = { id: 'a1', session }) {
  const decision = await injector.handle({ agent }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  const message = decision.messages.at(-1)
  if (message !== undefined && message.source?.plugin === 'memory') session.append(message)
  return message
}

function makeInjector(dir, options = {}) {
  return new BootInjector({
    getMemoryDir: () => dir,
    getBootOptions: () => ({ bootFiles: ['SOUL.md', 'MEMORY.md', 'index.md'], bootMaxChars: 4000, indexBootMode: 'derive' }),
    getGates: () => ({ enabled: true, autoInject: true, deferUntilUserSpeaks: false, activeSessionOnly: false }),
    tracker: options.tracker,
    logger: { info() {}, warn() {} },
    pluginName: 'memory',
  })
}

test('first step injects the whole block as a snapshot section', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    const message = await step(injector, session)

    assert.equal(message.source.form, 'snapshot')
    assert.equal(message.source.plugin, 'memory')
    // Every part is named, so a later process can reconstruct what the model
    // holds straight from the durable message.
    assert.deepEqual(
      message.source.sections.map((section) => section.name),
      ['header', 'SOUL.md', 'MEMORY.md', 'index.md', 'log.md'].map((id) => `${BOOT_SECTION_PREFIX}${id}`),
    )
    assert.equal(
      message.source.sections.map((section) => section.text).join('\n\n---\n\n'),
      message.content[0].text,
      'the named parts are exactly the block the model sees',
    )
    assert.match(message.content[0].text, /MEMORY\.md/)
    assert.match(message.content[0].text, /boot 子集/)
    assert.match(message.content[0].text, /小蓝/)
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unchanged store injects nothing at all', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)
    const before = session.ownSeqs().length
    assert.equal(await step(injector, session), undefined)
    assert.equal(await step(injector, session), undefined)
    assert.equal(session.ownSeqs().length, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one changed part re-sends that part only, as a notice', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)

    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    const message = await step(injector, session)

    assert.equal(message.source.form, 'notice')
    assert.ok(message.source.summary.startsWith(NOTICE_SUMMARY_PREFIX))
    assert.match(message.content[0].text, /维护协议 v2/)
    assert.ok(!message.content[0].text.includes('可查就先自证'), 'unchanged parts are not repeated')
    assert.ok(message.content[0].text.length < 1200, 'the delta is much smaller than the full block')

    // And a second edit of the same part repeats only the new text.
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v3。\n')
    const second = await step(injector, session)
    assert.match(second.content[0].text, /维护协议 v3/)
    assert.ok(!second.content[0].text.includes('维护协议 v2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cold page changes stay invisible: no resident part moves', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)

    // A salience-2 page appears in the full catalog but not in the hot subset.
    writeFileSync(join(dir, 'index.md'), `# Memory Index

## identity

- [可查就先自证](identity/verify-before-answering.md) — 自查（salience 1）
- [温页](identity/warm.md) — 新写的（salience 2）
`)
    assert.equal(await step(injector, session), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a removed part is announced', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)

    rmSync(join(dir, 'log.md'))
    const message = await step(injector, session)
    assert.match(message.content[0].text, /已移除/)
    assert.match(message.content[0].text, /log\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compaction drops the baseline → the full block is injected again', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    await step(injector, session)

    session.drop(session.ownSeqs())
    const message = await step(injector, session)
    assert.equal(message.source.form, 'snapshot')
    assert.match(message.content[0].text, /可查就先自证/)
    assert.match(message.content[0].text, /维护协议 v2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a resumed process adopts a still-valid snapshot instead of re-injecting', async () => {
  const dir = makeStore()
  try {
    const first = makeInjector(dir)
    const session = makeSession()
    await step(first, session)

    // New process: no in-memory state, but the previous snapshot is on the
    // surface and every source file predates it.
    const resumed = makeInjector(dir)
    assert.equal(await step(resumed, session), undefined)

    // A change after the resume still produces a delta, proving the state was
    // adopted rather than left cold.
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    const message = await step(resumed, session)
    assert.equal(message.source.form, 'notice')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a resumed process diffs against the named parts of the visible snapshot', async () => {
  const dir = makeStore()
  try {
    const first = makeInjector(dir)
    const session = makeSession()
    await step(first, session)

    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    const resumed = makeInjector(dir)
    const message = await step(resumed, session)
    // The snapshot named its parts, so the new process knows exactly what the
    // model holds and can send the delta instead of the whole block.
    assert.equal(message.source.form, 'notice')
    assert.match(message.content[0].text, /维护协议 v2/)
    assert.ok(!message.content[0].text.includes('### SOUL.md'), 'unchanged parts stay unsent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a resumed process re-injects when the visible block names no parts', async () => {
  const dir = makeStore()
  try {
    const session = makeSession()
    // An older version of the plugin (or another producer) left a snapshot with
    // one unnamed section: only its whole text can be compared.
    const legacy = buildInjectionMessage({ text: 'legacy block', form: 'snapshot' }, 'memory')
    session.append(legacy)
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')

    const resumed = makeInjector(dir)
    const message = await step(resumed, session)
    assert.equal(message.source.form, 'snapshot')
    assert.match(message.content[0].text, /维护协议 v2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a step that never committed its injection re-injects instead of drifting', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    const first = await injector.handle({ agent: { id: 'a1', session } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(first.messages.length, 1)

    // The step is aborted before the host commits the message, and the store
    // changed in the meantime: the next step must deliver a full, current
    // block rather than a delta against a baseline the model never received.
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    const retry = await injector.handle({ agent: { id: 'a1', session } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const message = retry.messages.at(-1)
    assert.equal(message.source.form, 'snapshot')
    assert.match(message.content[0].text, /维护协议 v2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gates and a missing store suppress injection entirely', async () => {
  const dir = makeStore()
  try {
    const gated = new BootInjector({
      getMemoryDir: () => dir,
      getBootOptions: () => ({}),
      getGates: () => ({ enabled: true, autoInject: true }),
      tracker: { shouldInject: () => false },
      logger: { info() {}, warn() {} },
      pluginName: 'memory',
    })
    assert.equal(await step(gated, makeSession('gated')), undefined)

    const disabled = new BootInjector({
      getMemoryDir: () => dir,
      getBootOptions: () => ({}),
      getGates: () => ({ enabled: true, autoInject: false }),
      logger: { info() {}, warn() {} },
      pluginName: 'memory',
    })
    assert.equal(await step(disabled, makeSession('disabled')), undefined)

    const empty = makeInjector(join(dir, 'does-not-exist'))
    assert.equal(await step(empty, makeSession('empty')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('injection failures never break the step', async () => {
  const injector = new BootInjector({
    getMemoryDir: () => {
      throw new Error('boom')
    },
    getBootOptions: () => ({}),
    getGates: () => ({}),
    logger: { warn() {} },
    pluginName: 'memory',
  })
  const decision = await injector.handle({ agent: { id: 'a', session: makeSession() } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('per-session state is isolated', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const a = makeSession('a')
    const b = makeSession('b')
    await step(injector, a)
    const message = await step(injector, b)
    assert.equal(message.source.form, 'snapshot', 'a second session still gets its own full block')

    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    assert.equal((await step(injector, a)).source.form, 'notice', 'a diffs against its own baseline')
    assert.equal((await step(injector, b)).source.form, 'notice', 'b diffs against its own baseline')
    assert.equal(await step(injector, a), undefined, 'no duplicate injection once both are current')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset forgets state and re-derives it from the surface', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    const session = makeSession()
    await step(injector, session)

    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    await step(injector, session)

    injector.reset(session.id)
    // The surface still carries the full block + delta, so nothing is re-sent…
    assert.equal(await step(injector, session), undefined)
    // …and the next real change is still diffed correctly against it.
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v3。\n')
    const message = await step(injector, session)
    assert.equal(message.source.form, 'notice')
    assert.match(message.content[0].text, /维护协议 v3/)
    assert.ok(!message.content[0].text.includes('维护协议 v2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildInjectionMessage carries supersede-vs-append semantics honestly', () => {
  const full = buildInjectionMessage({ text: 'full', form: 'snapshot' }, 'memory')
  assert.equal(full.source.form, 'snapshot')
  assert.deepEqual(full.source.sections, [{ name: BOOT_SECTION_NAME, text: 'full' }])

  const delta = buildInjectionMessage({ text: 'delta', form: 'notice', summary: '记忆增量更新：MEMORY.md' }, 'memory')
  assert.equal(delta.source.form, 'notice')
  assert.equal(delta.source.summary, '记忆增量更新：MEMORY.md')
  assert.equal(delta.source.sections, undefined)
})

test('readOwnInjections ignores foreign messages, other plugins and same-name nudges', () => {
  const session = makeSession()
  session.append({ id: '1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  session.append({ id: '2', role: 'user', content: [{ type: 'text', text: 'other' }], source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time', text: 'other' }] } })
  session.append(buildInjectionMessage({ text: 'mine', form: 'snapshot' }, 'memory'))
  session.append(buildInjectionMessage({ text: `${DELTA_MARKER} · @log.li/dsh-memory】…`, form: 'notice', summary: `${NOTICE_SUMMARY_PREFIX}：x` }, 'memory'))
  // Same plugin name, different purpose: the digest / recall nudges carry no
  // `form` at all and must never enter the injection ledger.
  session.append({ id: '5', role: 'user', content: [{ type: 'text', text: '记忆库今天还没写回…' }], source: { kind: 'plugin', plugin: 'memory' } })
  // A notice from another producer that happens to reuse our summary prefix.
  session.append({ id: '6', role: 'user', content: [{ type: 'text', text: '别的通知正文' }], source: { kind: 'plugin', plugin: 'memory', form: 'notice', summary: `${NOTICE_SUMMARY_PREFIX}：y` } })
  // A snapshot whose sections are not ours.
  session.append({ id: '7', role: 'user', content: [{ type: 'text', text: 'other snapshot' }], source: { kind: 'plugin', plugin: 'memory', form: 'snapshot', sections: [{ name: 'other', text: 'x' }] } })

  const found = readOwnInjections(session, 'memory')
  assert.deepEqual(found.map((entry) => entry.text), ['mine', `${DELTA_MARKER} · @log.li/dsh-memory】…`])
  assert.deepEqual(found.map((entry) => entry.form), ['snapshot', 'notice'])
  // A block injected without named parts (the compatibility fallback) is still
  // recognised as ours, but yields no part inventory.
  assert.equal(found[0].parts, undefined)

  const withParts = makeSession('parts')
  withParts.append(buildInjectionMessage({
    text: 'header\n\n---\n\nbody',
    form: 'snapshot',
    parts: [{ id: 'header', text: 'header' }, { id: 'MEMORY.md', text: 'body' }],
  }, 'memory'))
  const ledger = readOwnInjections(withParts, 'memory')
  assert.deepEqual(ledger[0].parts.map((part) => part.id), ['header', 'MEMORY.md'])
})

test('a session without an exposed surface degrades to full blocks only', async () => {
  const dir = makeStore()
  try {
    const injector = makeInjector(dir)
    // A session whose `surface` is unavailable (host API drift): the plugin must
    // never diff against a baseline it cannot verify, and must never loop.
    const session = { id: 'no-surface', append() {} }
    const first = await injector.handle({ agent: { id: 'a1', session } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(first.messages.at(-1).source.form, 'snapshot')

    const second = await injector.handle({ agent: { id: 'a1', session } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.deepEqual(second.messages, [], 'an unchanged store injects nothing, not the block again')

    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY\n\n维护协议 v2。\n')
    const third = await injector.handle({ agent: { id: 'a1', session } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(third.messages.at(-1).source.form, 'snapshot')
    assert.match(third.messages.at(-1).content[0].text, /维护协议 v2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
