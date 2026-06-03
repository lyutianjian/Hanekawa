import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRewindSummaryRewrite } from '../src/tui/rewindSummary.js'
import type { SessionRecord } from '../src/harness/types.js'

function user(id: string, content = id): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'user',
    content,
    createdAt: '2026-06-01T00:00:00.000Z',
  }
}

function assistant(id: string, content = id): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'assistant',
    content,
    createdAt: '2026-06-01T00:00:01.000Z',
  }
}

test('Summarize from here keeps prior records and replaces selected-and-later records', async () => {
  const records = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
  const summarizedIds: string[] = []

  const rewrite = await buildRewindSummaryRewrite({
    records,
    targetMessageId: 'u2',
    decision: 'summarize-from-here',
    summarize: async (segment) => {
      summarizedIds.push(...segment.map((record) => 'id' in record ? record.id : ''))
      return { summary: 'from summary', preTokens: 22 }
    },
    createId: () => 'compact-from',
    now: () => '2026-06-01T00:00:02.000Z',
  })

  assert.deepEqual(summarizedIds, ['u2', 'a2'])
  assert.deepEqual(rewrite.nextRecords.map((record) => 'id' in record ? record.id : null), ['u1', 'a1', 'compact-from'])
  assert.equal(rewrite.boundary.summary, 'from summary')
  assert.equal(rewrite.boundary.preTokens, 22)
})

test('Summarize up to here replaces earlier records and keeps selected-and-later records', async () => {
  const records = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
  const summarizedIds: string[] = []

  const rewrite = await buildRewindSummaryRewrite({
    records,
    targetMessageId: 'u2',
    decision: 'summarize-up-to-here',
    summarize: async (segment) => {
      summarizedIds.push(...segment.map((record) => 'id' in record ? record.id : ''))
      return { summary: 'up summary', preTokens: 11 }
    },
    createId: () => 'compact-up',
    now: () => '2026-06-01T00:00:02.000Z',
  })

  assert.deepEqual(summarizedIds, ['u1', 'a1'])
  assert.deepEqual(rewrite.nextRecords.map((record) => 'id' in record ? record.id : null), ['compact-up', 'u2', 'a2'])
  assert.equal(rewrite.boundary.summary, 'up summary')
  assert.equal(rewrite.boundary.postCompactRestore, 'pending')
})

test('Summarize up to here rejects the first user message', async () => {
  await assert.rejects(
    () => buildRewindSummaryRewrite({
      records: [user('u1'), assistant('a1')],
      targetMessageId: 'u1',
      decision: 'summarize-up-to-here',
      summarize: async () => ({ summary: 'unused', preTokens: 1 }),
    }),
    /No earlier conversation to summarize/,
  )
})
