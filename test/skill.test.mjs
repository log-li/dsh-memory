import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memorySkillContent, MEMORY_SKILL_NAME, MEMORY_SKILL_DESCRIPTION, MEMORY_SKILL_WHEN_TO_USE } from '../lib/skill.js'

test('memory skill ships its protocol body', () => {
  const content = memorySkillContent()
  assert.ok(content.length > 500, 'instruction body must be non-trivial')
  // The four operations are the heart of the protocol.
  assert.match(content, /remember|记/)
  assert.match(content, /recall|忆/)
  assert.match(content, /consolidate|整理/)
  assert.match(content, /forget|忘/)
  // Digest is a hard duty, not optional.
  assert.match(content, /digest/)
})

test('skill metadata stays consistent', () => {
  const content = memorySkillContent()
  assert.equal(MEMORY_SKILL_NAME, 'memory')
  assert.match(MEMORY_SKILL_DESCRIPTION, /digest/)
  assert.match(MEMORY_SKILL_WHEN_TO_USE, /会话开始/)
  // v0.8.0: the plugin is memory, not a persona — no soul/bootstrap protocol.
  assert.ok(!/SOUL\.md/.test(content), 'no SOUL.md protocol left in the skill')
  assert.ok(!/首要任务/.test(content), 'no first-task instruction left')
  // v0.8.0 removed the digest reminder: the protocol must not promise one.
  assert.ok(!/digest 提醒/.test(content), 'no promise of a removed reminder')
  assert.ok(!/解除提醒/.test(content), 'no reminder-clearing instruction')
  assert.ok(!/automemory（可选，默认关）/.test(content), 'automemory default is on now')
  assert.ok(!/BOOTSTRAP\.md/.test(content), 'no bootstrap checklist left')
  assert.match(content, /memory_search/)
  assert.match(content, /memory_write/)
})
