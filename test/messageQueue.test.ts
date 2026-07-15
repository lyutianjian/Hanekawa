import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageQueueRecord, SessionRecord } from '../src/harness/types.js'
import {
  clearMessageQueue,
  dequeueMessage,
  enqueueMessage,
  getMessageQueueSnapshot,
  hydrateMessageQueue,
  initializeMessageQueue,
  migrateMessageQueue,
  replayMessageQueue,
  subscribeMessageQueue,
} from '../src/tui/messageQueue.js'

describe('messageQueue', () => {
  let persisted: Array<{ sessionId: string; record: MessageQueueRecord }>

  beforeEach(() => {
    persisted = []
    initializeMessageQueue('session-a', [], async (sessionId, record) => {
      persisted.push({ sessionId, record })
    })
  })

  it('persists and consumes messages in FIFO order regardless of priority', async () => {
    const first = await enqueueMessage('first', 'later')
    const second = await enqueueMessage('second', 'now')
    assert.deepEqual(getMessageQueueSnapshot().map((item) => item.content), ['first', 'second'])
    assert.equal((await dequeueMessage())?.id, first.id)
    assert.equal((await dequeueMessage())?.id, second.id)
    assert.equal(getMessageQueueSnapshot().length, 0)
    assert.deepEqual(persisted.map(({ record }) => record.operation), ['enqueue', 'enqueue', 'dequeue', 'dequeue'])
  })

  it('keeps the snapshot stable and notifies only on changes', async () => {
    const initial = getMessageQueueSnapshot()
    let notifications = 0
    const unsubscribe = subscribeMessageQueue(() => notifications++)
    await hydrateMessageQueue([])
    assert.equal(getMessageQueueSnapshot(), initial)
    assert.equal(notifications, 0)
    await enqueueMessage('hello')
    assert.equal(notifications, 1)
    unsubscribe()
  })

  it('does not mutate memory when persistence fails', async () => {
    initializeMessageQueue('session-a', [], async () => {
      throw new Error('disk full')
    })
    await assert.rejects(() => enqueueMessage('hello'), /disk full/)
    assert.equal(getMessageQueueSnapshot().length, 0)
  })

  it('replays enqueue, dequeue, clear, duplicate, and unknown events safely', () => {
    const base = new Date().toISOString()
    const message = { id: 'm1', content: 'one', priority: 'next' as const, createdAt: base }
    const records: SessionRecord[] = [
      { id: 'e1', type: 'message_queue', operation: 'enqueue', message, createdAt: base },
      { id: 'e2', type: 'message_queue', operation: 'enqueue', message, createdAt: base },
      { id: 'd0', type: 'message_queue', operation: 'dequeue', messageId: 'missing', createdAt: base },
      { id: 'd1', type: 'message_queue', operation: 'dequeue', messageId: 'm1', createdAt: base },
      { id: 'e3', type: 'message_queue', operation: 'enqueue', message: { ...message, id: 'm2' }, createdAt: base },
      { id: 'c1', type: 'message_queue', operation: 'clear', createdAt: base },
    ]
    assert.deepEqual(replayMessageQueue(records), [])
  })

  it('clears and migrates pending messages between sessions', async () => {
    await enqueueMessage('one')
    await enqueueMessage('two')
    await migrateMessageQueue('session-b', [])
    assert.deepEqual(getMessageQueueSnapshot().map((item) => item.content), ['one', 'two'])
    assert.deepEqual(persisted.slice(-3).map((entry) => [entry.sessionId, entry.record.operation]), [
      ['session-b', 'enqueue'],
      ['session-b', 'enqueue'],
      ['session-a', 'clear'],
    ])
    await clearMessageQueue()
    assert.equal(getMessageQueueSnapshot().length, 0)
    assert.equal(persisted.at(-1)?.sessionId, 'session-b')
  })
})
