import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileOrphanedAgents } from '../src/runtime/sessionSwitch.js'
import type { SessionRecord } from '../src/harness/types.js'

/**
 * The switch itself needs a live runtime, so what is tested here is the part
 * that decides *what to write*: agents still marked running that did not
 * survive into this process. Without it a resumed transcript shows them
 * running forever.
 */

function task(
  agentId: string,
  status: 'running' | 'completed',
  id = `rec-${agentId}`,
): Extract<SessionRecord, { type: 'subagent_task' }> {
  return {
    type: 'subagent_task',
    id,
    agentId,
    subagentType: 'explore',
    task: 'look around',
    description: 'look around',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

const now = () => '2026-08-15T12:00:00.000Z'
let counter = 0
const createId = () => `new-${(counter += 1)}`

test('no orphans means no records to write', () => {
  assert.deepEqual(reconcileOrphanedAgents([task('a', 'running')], [], now, createId), [])
})

test('a running orphan becomes an interruption record', () => {
  counter = 0
  const [record] = reconcileOrphanedAgents([task('a', 'running')], ['a'], now, createId)

  assert.ok(record && record.type === 'subagent_task')
  assert.equal(record.agentId, 'a')
  assert.equal(record.status, 'interrupted')
  assert.equal(record.error, 'Background agent was not present when the session resumed')
  assert.equal(record.createdAt, now())
  assert.equal(record.id, 'new-1', 'a fresh id, so the original record is preserved')
})

test('an agent that already finished is left alone', () => {
  counter = 0
  assert.deepEqual(
    reconcileOrphanedAgents([task('a', 'completed')], ['a'], now, createId),
    [],
  )
})

test('an orphan with no record at all is ignored', () => {
  counter = 0
  assert.deepEqual(reconcileOrphanedAgents([], ['ghost'], now, createId), [])
})

test('only the latest record for an agent decides its fate', () => {
  counter = 0
  const records = [task('a', 'running', 'first'), task('a', 'completed', 'second')]

  assert.deepEqual(reconcileOrphanedAgents(records, ['a'], now, createId), [],
    'the later completion wins over the earlier running record')
})

test('several orphans each get their own record', () => {
  counter = 0
  const records = [task('a', 'running'), task('b', 'running'), task('c', 'completed')]

  const written = reconcileOrphanedAgents(records, ['a', 'b', 'c'], now, createId)

  assert.deepEqual(written.map((record) => record.type === 'subagent_task' && record.agentId), ['a', 'b'])
  assert.deepEqual(written.map((record) => record.id), ['new-1', 'new-2'])
})
