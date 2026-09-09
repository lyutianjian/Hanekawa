import test from 'node:test'
import assert from 'node:assert/strict'
import { canPumpQueue, handOffQueuedMessage, type QueuePumpState } from '../src/runtime/queuePump.js'
import type { QueuedMessage } from '../src/runtime/messageQueue.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

const ready: QueuePumpState = { pending: 1, running: false, turnActive: false, uiBlocked: false }

test('the pump runs only when a message is waiting and nothing else is in flight', () => {
  assert.equal(canPumpQueue(ready), true)
})

test('each guard on its own is enough to hold the pump back', () => {
  assert.equal(canPumpQueue({ ...ready, pending: 0 }), false)
  assert.equal(canPumpQueue({ ...ready, running: true }), false)
  assert.equal(canPumpQueue({ ...ready, turnActive: true }), false)
  assert.equal(canPumpQueue({ ...ready, uiBlocked: true }), false)
})

test('a deeper queue does not override the guards', () => {
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: true, uiBlocked: false }), false)
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: false, uiBlocked: true }), false)
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: false, uiBlocked: false }), true)
})

test('a blocked message holds the pump only while it is still the head', () => {
  const blocked: QueuePumpState = { ...ready, headMessageId: 'm1', blockedMessageId: 'm1' }
  assert.equal(canPumpQueue(blocked), false)

  // The user removed it, or put another message in front of it: nothing has to
  // clear the block explicitly for the pump to start again.
  assert.equal(canPumpQueue({ ...blocked, headMessageId: 'm2' }), true)
  assert.equal(canPumpQueue({ ...ready, headMessageId: 'm1' }), true)
})

// --- the hand-off -----------------------------------------------------------

function queued(id: string, content = 'hello'): QueuedMessage {
  return { id, content, priority: 'next', createdAt: new Date().toISOString() }
}

/** A queue of one, with the consume calls it received. */
function fakeQueue(messages: QueuedMessage[]) {
  const consumed: string[] = []
  return {
    consumed,
    peek: () => messages[0],
    consume: async (messageId: string) => {
      consumed.push(messageId)
      const index = messages.findIndex((message) => message.id === messageId)
      if (index >= 0) messages.splice(index, 1)
    },
  }
}

test('nothing to hand off is not an error', async () => {
  const queue = fakeQueue([])
  const outcome = await handOffQueuedMessage({
    ...queue,
    deliver: async () => assert.fail('nothing may be delivered from an empty queue'),
  })
  assert.deepEqual(outcome, { kind: 'idle' })
})

test('a message is consumed when the runtime accepts it, not when the turn ends', async () => {
  const image = makeImageAttachmentRef({ id: 'img-1', ownerSessionId: 'session-a' })
  const message = { ...queued('m1', 'look'), images: [image] }
  const queue = fakeQueue([message])
  let consumedAtAcceptance: string[] = []

  const outcome = await handOffQueuedMessage({
    ...queue,
    deliver: async (input, context) => {
      assert.deepEqual(input, { text: 'look', images: [image] }, 'the refs ride along')
      assert.equal(context.queuedMessageId, 'm1')
      assert.deepEqual(queue.consumed, [], 'still queued while the runtime decides')
      context.onAccepted()
      consumedAtAcceptance = [...queue.consumed]
      // The rest of the turn happens after acceptance and must not undo it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  })

  assert.deepEqual(consumedAtAcceptance, ['m1'], 'acceptance is what consumes it')
  assert.deepEqual(outcome, { kind: 'sent', message })
})

test('a refusal before acceptance leaves the message queued and blocks the pump', async () => {
  const message = queued('m1')
  const queue = fakeQueue([message])

  const outcome = await handOffQueuedMessage({
    ...queue,
    deliver: async () => { throw new Error('the active model cannot accept images') },
  })

  assert.deepEqual(outcome, { kind: 'blocked', message, reason: 'the active model cannot accept images' })
  assert.deepEqual(queue.consumed, [], 'nothing was consumed, so nothing was lost')
})

test('a turn that fails after acceptance still consumes the message', async () => {
  const message = queued('m1')
  const queue = fakeQueue([message])

  const outcome = await handOffQueuedMessage({
    ...queue,
    deliver: async (_input, context) => {
      context.onAccepted()
      throw new Error('provider exploded')
    },
  })

  // Committed-turn semantics: the user message is in the conversation, so
  // putting it back would send it twice.
  assert.deepEqual(outcome, { kind: 'failed', message, reason: 'provider exploded' })
  assert.deepEqual(queue.consumed, ['m1'])
})

test('a delivery with no user record — a slash command — is still consumed once', async () => {
  const message = queued('m1', '/help')
  const queue = fakeQueue([message])

  const outcome = await handOffQueuedMessage({ ...queue, deliver: async () => {} })

  assert.deepEqual(outcome, { kind: 'sent', message })
  assert.deepEqual(queue.consumed, ['m1'], 'exactly once, or the command runs again')
})

test('a removal that cannot be persisted stops the pump instead of resending', async () => {
  const message = queued('m1')
  const outcome = await handOffQueuedMessage({
    peek: () => message,
    consume: async () => { throw new Error('disk full') },
    deliver: async (_input, context) => { context.onAccepted() },
  })

  assert.equal(outcome.kind, 'blocked')
  assert.match(outcome.kind === 'blocked' ? outcome.reason : '', /disk full/)
})
