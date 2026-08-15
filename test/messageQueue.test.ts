import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageQueueRecord, SessionRecord } from '../src/harness/types.js'
import { MessageQueue, replayMessageQueue } from '../src/runtime/messageQueue.js'

describe('messageQueue', () => {
  let persisted: Array<{ sessionId: string; record: MessageQueueRecord }>
  let queue: MessageQueue

  beforeEach(() => {
    persisted = []
    queue = new MessageQueue('session-a', [], async (sessionId, record) => {
      persisted.push({ sessionId, record })
    })
  })

  it('persists and consumes messages in FIFO order regardless of priority', async () => {
    const first = await queue.enqueue('first', 'later')
    const second = await queue.enqueue('second', 'now')
    assert.deepEqual(queue.getSnapshot().map((item) => item.content), ['first', 'second'])
    assert.equal((await queue.dequeue())?.id, first.id)
    assert.equal((await queue.dequeue())?.id, second.id)
    assert.equal(queue.getSnapshot().length, 0)
    assert.deepEqual(persisted.map(({ record }) => record.operation), ['enqueue', 'enqueue', 'dequeue', 'dequeue'])
  })

  it('keeps the snapshot stable and notifies only on changes', async () => {
    const initial = queue.getSnapshot()
    let notifications = 0
    const unsubscribe = queue.subscribe(() => notifications++)
    await queue.hydrate([])
    assert.equal(queue.getSnapshot(), initial)
    assert.equal(notifications, 0)
    await queue.enqueue('hello')
    assert.equal(notifications, 1)
    unsubscribe()
  })

  it('does not mutate memory when persistence fails', async () => {
    const failing = new MessageQueue('session-a', [], async () => {
      throw new Error('disk full')
    })
    await assert.rejects(() => failing.enqueue('hello'), /disk full/)
    assert.equal(failing.getSnapshot().length, 0)
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
    await queue.enqueue('one')
    await queue.enqueue('two')
    await queue.migrateTo('session-b', [])
    assert.deepEqual(queue.getSnapshot().map((item) => item.content), ['one', 'two'])
    assert.deepEqual(persisted.slice(-3).map((entry) => [entry.sessionId, entry.record.operation]), [
      ['session-b', 'enqueue'],
      ['session-b', 'enqueue'],
      ['session-a', 'clear'],
    ])
    await queue.clear()
    assert.equal(queue.getSnapshot().length, 0)
    assert.equal(persisted.at(-1)?.sessionId, 'session-b')
  })

  it('retargets a session without carrying the previous one\'s pending messages', async () => {
    await queue.enqueue('stale')
    await queue.reset('session-b', [])

    assert.equal(queue.getSnapshot().length, 0)
    await queue.enqueue('fresh')
    assert.equal(persisted.at(-1)?.sessionId, 'session-b')
  })

  it('keeps two queues independent', async () => {
    const other = new MessageQueue('session-b', [], async (sessionId, record) => {
      persisted.push({ sessionId, record })
    })
    let notifications = 0
    const unsubscribe = queue.subscribe(() => notifications++)

    await other.enqueue('theirs')

    assert.deepEqual(other.getSnapshot().map((item) => item.content), ['theirs'])
    assert.equal(queue.getSnapshot().length, 0)
    assert.equal(notifications, 0)
    assert.deepEqual(persisted.map((entry) => entry.sessionId), ['session-b'])

    await queue.enqueue('mine')
    assert.deepEqual(queue.getSnapshot().map((item) => item.content), ['mine'])
    assert.deepEqual(other.getSnapshot().map((item) => item.content), ['theirs'])
    unsubscribe()
  })
})
