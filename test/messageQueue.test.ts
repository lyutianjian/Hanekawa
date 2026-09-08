import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageQueueRecord, SessionRecord } from '../src/harness/types.js'
import { MessageQueue, queuedMessageToInput, replayMessageQueue } from '../src/runtime/messageQueue.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

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
    const first = await queue.enqueue({ text: 'first' }, 'later')
    const second = await queue.enqueue({ text: 'second' }, 'now')
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
    await queue.enqueue({ text: 'hello' })
    assert.equal(notifications, 1)
    unsubscribe()
  })

  it('does not mutate memory when persistence fails', async () => {
    const failing = new MessageQueue('session-a', [], async () => {
      throw new Error('disk full')
    })
    await assert.rejects(() => failing.enqueue({ text: 'hello' }), /disk full/)
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
    await queue.enqueue({ text: 'one' })
    await queue.enqueue({ text: 'two' })
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
    await queue.enqueue({ text: 'stale' })
    await queue.reset('session-b', [])

    assert.equal(queue.getSnapshot().length, 0)
    await queue.enqueue({ text: 'fresh' })
    assert.equal(persisted.at(-1)?.sessionId, 'session-b')
  })

  it('keeps two queues independent', async () => {
    const other = new MessageQueue('session-b', [], async (sessionId, record) => {
      persisted.push({ sessionId, record })
    })
    let notifications = 0
    const unsubscribe = queue.subscribe(() => notifications++)

    await other.enqueue({ text: 'theirs' })

    assert.deepEqual(other.getSnapshot().map((item) => item.content), ['theirs'])
    assert.equal(queue.getSnapshot().length, 0)
    assert.equal(notifications, 0)
    assert.deepEqual(persisted.map((entry) => entry.sessionId), ['session-b'])

    await queue.enqueue({ text: 'mine' })
    assert.deepEqual(queue.getSnapshot().map((item) => item.content), ['mine'])
    assert.deepEqual(other.getSnapshot().map((item) => item.content), ['theirs'])
    unsubscribe()
  })

  it('replays queued image refs intact and rejects malformed ones', () => {
    const base = new Date().toISOString()
    const image = makeImageAttachmentRef({ id: 'img-q1', ownerSessionId: 'session-a', name: 'queued.png' })
    const good = { id: 'm1', content: 'with image', priority: 'next' as const, createdAt: base, images: [image] }
    const records: SessionRecord[] = [
      { id: 'e1', type: 'message_queue', operation: 'enqueue', message: good, createdAt: base },
      // The malformed entries are deliberately mis-typed: replay parses
      // whatever an old or corrupted log line contains, not what the types promise.
      { id: 'e2', type: 'message_queue', operation: 'enqueue', message: { ...good, id: 'm2', images: 'not-an-array' } as unknown as typeof good, createdAt: base },
      { id: 'e3', type: 'message_queue', operation: 'enqueue', message: { ...good, id: 'm3', images: [{ ...image, id: 42 }] } as unknown as typeof good, createdAt: base },
      { id: 'e4', type: 'message_queue', operation: 'enqueue', message: { id: 'm4', content: 'with image', priority: 'next', createdAt: base }, createdAt: base },
    ]

    const replayed = replayMessageQueue(records)
    assert.deepEqual(replayed.map((message) => message.id), ['m1', 'm4'])
    assert.deepEqual(replayed[0]?.images, [image])
    assert.equal('images' in (replayed[1] ?? {}), false)
  })

  it('keeps a hydrate with identical image refs from notifying listeners', async () => {
    const image = makeImageAttachmentRef({ id: 'img-q2', ownerSessionId: 'session-a' })
    const persistedRecords: SessionRecord[] = [{
      id: 'e1',
      type: 'message_queue',
      operation: 'enqueue',
      message: { id: 'm1', content: 'with image', priority: 'next', createdAt: new Date().toISOString(), images: [image] },
      createdAt: new Date().toISOString(),
    }]
    const hydrated = new MessageQueue('session-a', persistedRecords, async () => {})

    let notifications = 0
    const unsubscribe = hydrated.subscribe(() => notifications++)
    await hydrated.hydrate(persistedRecords)
    assert.deepEqual(hydrated.getSnapshot()[0]?.images, [image])
    assert.equal(notifications, 0)
    unsubscribe()
  })

  it('enqueues a UserInput as content plus image refs and hands it back as one', async () => {
    const image = makeImageAttachmentRef({ id: 'img-e1', ownerSessionId: 'session-a', name: 'shot.png' })
    const withImages = await queue.enqueue({ text: 'look at this', images: [image] })
    assert.equal(withImages.content, 'look at this')
    assert.deepEqual(withImages.images, [image])
    assert.deepEqual(queuedMessageToInput(withImages), { text: 'look at this', images: [image] })
    // The persisted record is what a restart replays: text and refs, nothing else.
    const firstRecord = persisted[0]?.record
    const persistedMessage = firstRecord?.type === 'message_queue' && firstRecord.operation === 'enqueue'
      ? firstRecord.message
      : undefined
    assert.equal(persistedMessage?.content, 'look at this')
    assert.deepEqual(persistedMessage?.images, [image])

    // A text-only input leaves the key absent, so old logs and new ones agree.
    const plain = await queue.enqueue({ text: 'no images' })
    assert.equal('images' in plain, false)
    assert.deepEqual(queuedMessageToInput(plain), { text: 'no images' })
  })
})
