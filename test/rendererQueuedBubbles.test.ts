import test from 'node:test'
import assert from 'node:assert/strict'
import type { PersistedQueuedMessage } from '../src/harness/types.js'
import {
  applySessionEvent,
  createTranscriptState,
  withQueuedMessages,
} from '../src/desktop/renderer/model/transcript.js'

function queued(id: string, content: string): PersistedQueuedMessage {
  return { id, content, priority: 'next', createdAt: '2026-09-30T00:00:00.000Z' }
}

test('a queued message shows as a user bubble at the tail until the transcript carries it', () => {
  const started = applySessionEvent(createTranscriptState(), {
    type: 'turn-start',
    messageId: 'm1',
    displayInput: 'fix the bug',
    createdAt: '2026-09-30T00:00:00.000Z',
  }).state
  const waiting = withQueuedMessages(started, [queued('q1', 'only in src')])
  assert.deepEqual(waiting.items.map((item) => [item.kind, item.text]), [['user', 'fix the bug'], ['user', 'only in src']])

  // Steered into the turn: the record names its queued message, so the bubble
  // is not drawn twice while the queue's own update is still on its way.
  const steered = applySessionEvent(started, {
    type: 'record',
    record: {
      type: 'message',
      id: 'm2',
      role: 'user',
      content: 'only in src',
      sourceQueuedMessageId: 'q1',
      createdAt: '2026-09-30T00:00:01.000Z',
    },
  }).state
  assert.equal(withQueuedMessages(steered, [queued('q1', 'only in src')]).items.filter((item) => item.kind === 'user').length, 2)
})

test('a queued message the pump started a turn from is not drawn twice', () => {
  const started = applySessionEvent(createTranscriptState(), {
    type: 'turn-start',
    messageId: 'm1',
    displayInput: 'next task',
    createdAt: '2026-09-30T00:00:00.000Z',
    queuedMessageId: 'q1',
  }).state
  assert.equal(withQueuedMessages(started, [queued('q1', 'next task')]).items.length, 1)
})
