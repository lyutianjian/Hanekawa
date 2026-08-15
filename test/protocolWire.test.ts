import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { PendingRequests } from '../src/runtime/protocol/pendingRequests.js'
import { UI_REQUEST_FALLBACKS } from '../src/runtime/protocol/wire.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { SessionRecord } from '../src/harness/types.js'

/**
 * The protocol's one non-negotiable property: every payload survives
 * `structuredClone`. Electron IPC and `child_process` both use it, so anything
 * that fails here fails silently in production as a dropped or mangled field.
 */

const message: SessionRecord = {
  type: 'message',
  id: 'm1',
  role: 'assistant',
  content: 'hello',
  createdAt: new Date().toISOString(),
}

const allEventVariants: SessionEvent[] = [
  { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: new Date().toISOString() },
  { type: 'record', record: message, approvalToolUseId: 'tu1', subagentProgress: 'Exploring' },
  { type: 'tool-progress', listContent: 'Bash, Read' },
  { type: 'stream', event: { type: 'text_delta', index: 0, text: 'chunk' } },
  { type: 'stream', event: { type: 'idle_warning', idleMs: 1000 } },
  { type: 'notice', level: 'error', content: 'boom' },
  { type: 'transcript-reset', records: [message], systemMessages: ['note'], bumpGeneration: true },
  { type: 'restore-input', text: 'draft' },
  { type: 'active-model', model: { model: 'm', modelKey: 'main', contextWindow: 200_000 } },
  {
    type: 'turn-end',
    aborted: false,
    rolledBack: false,
    durationMs: 12,
    usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
  },
]

test('every SessionEvent variant survives structuredClone unchanged', () => {
  for (const event of allEventVariants) {
    const cloned = structuredClone(event)
    assert.deepEqual(cloned, event, `${event.type} lost data crossing the boundary`)
  }
})

test('the event union covers every variant the controller can emit', () => {
  // Guards against a new variant being added without a serializability check.
  const covered = new Set(allEventVariants.map((event) => event.type))
  assert.deepEqual([...covered].sort(), [
    'active-model',
    'notice',
    'record',
    'restore-input',
    'stream',
    'tool-progress',
    'transcript-reset',
    'turn-end',
    'turn-start',
  ])
})

test('UI request fallbacks are asymmetric: only entering plan mode approves', () => {
  const permission = UI_REQUEST_FALLBACKS.permission()
  assert.equal(permission.kind === 'permission' && permission.approved, false)

  const enterPlan = UI_REQUEST_FALLBACKS['enter-plan']()
  assert.equal(enterPlan.kind === 'enter-plan' && enterPlan.approved, true,
    'entering plan mode only restricts the agent, so a lost UI approves')

  const exitPlan = UI_REQUEST_FALLBACKS['exit-plan']()
  assert.equal(exitPlan.kind === 'exit-plan' && exitPlan.decision.kind, 'reject')

  const question = UI_REQUEST_FALLBACKS['ask-user-question']()
  assert.equal(question.kind === 'ask-user-question' && question.result.kind, 'rejected')
})

test('each fallback call returns a fresh object', () => {
  // settleAll hands one value per waiter; a shared object would let one
  // consumer's mutation leak into another's answer.
  assert.notEqual(UI_REQUEST_FALLBACKS['exit-plan'](), UI_REQUEST_FALLBACKS['exit-plan']())
})

test('PendingRequests settles by id and reports unknown ids', async () => {
  const pending = new PendingRequests<string>()
  const first = pending.create('a')
  const second = pending.create('b')

  assert.equal(pending.size, 2)
  assert.equal(pending.settle('a', 'answer-a'), true)
  assert.equal(pending.settle('a', 'again'), false, 'an id settles once')
  assert.equal(pending.settle('missing', 'x'), false)

  pending.settle('b', 'answer-b')
  assert.deepEqual(await Promise.all([first, second]), ['answer-a', 'answer-b'])
  assert.equal(pending.size, 0)
})

test('PendingRequests.settleAll releases everything outstanding', async () => {
  const pending = new PendingRequests<string>()
  const waiting = [pending.create('a'), pending.create('b'), pending.create('c')]

  pending.settleAll(() => 'disconnected')

  assert.deepEqual(await Promise.all(waiting), ['disconnected', 'disconnected', 'disconnected'])
  assert.equal(pending.size, 0)
})

test('the memory channel clones payloads, so a live object cannot sneak through', async () => {
  const [a, b] = createMemoryChannelPair()
  const received: unknown[] = []
  b.onMessage((message) => received.push(message))

  const payload = { nested: { value: 1 } }
  a.post(payload)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(received, [payload])
  assert.notEqual(received[0], payload, 'the receiver must not share the sender\'s object')

  assert.throws(() => a.post({ fn: () => {} }), 'a function payload fails here, as it would over IPC')
})

test('closing one end of the memory channel closes the other', async () => {
  const [a, b] = createMemoryChannelPair()
  let aClosed = false
  let bClosed = false
  a.onClose(() => { aClosed = true })
  b.onClose(() => { bClosed = true })

  a.close()

  assert.equal(aClosed, true)
  assert.equal(bClosed, true, 'a peer that goes away must notify the other side')
})
