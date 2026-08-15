import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import type { HostCommand, HostEvent } from '../src/runtime/protocol/wire.js'
import type { SessionControllerSnapshot, SessionEvent } from '../src/runtime/sessionController.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'

/**
 * The client is the half a renderer holds. Its one hard requirement is the
 * `useSyncExternalStore` contract: `getSnapshot()` must keep returning the same
 * object while nothing has changed. In-process that falls out of
 * `SessionController.publish` comparing by reference, but every deserialized
 * message is a fresh object graph, so the client has to restore the invariant
 * itself or React re-renders forever.
 */

interface Harness {
  client: SessionClient
  hostSide: RuntimeChannel
  sent: HostCommand[]
  post: (event: HostEvent) => void
}

function createHarness(): Harness {
  const [hostSide, clientSide] = createMemoryChannelPair()
  const sent: HostCommand[] = []
  hostSide.onMessage((message) => sent.push(message as HostCommand))
  return {
    client: new SessionClient(clientSide),
    hostSide,
    sent,
    post: (event) => hostSide.post(event),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function snapshot(overrides: Partial<SessionControllerSnapshot> = {}): SessionControllerSnapshot {
  return {
    isStreaming: false,
    usage: { lastRequest: null, total: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 } },
    taskSnapshot: undefined,
    spinnerSubText: undefined,
    ...overrides,
  }
}

test('an identical snapshot message does not change getSnapshot identity', async () => {
  const harness = createHarness()
  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const first = harness.client.getSnapshot()
  assert.equal(notifications, 1)

  // Structurally equal but a different object graph, as every IPC message is.
  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()

  assert.equal(harness.client.getSnapshot(), first,
    'useSyncExternalStore throws "getSnapshot should be cached" if this changes')
  assert.equal(notifications, 1, 'and no listener should be woken for nothing')
  harness.client.dispose()
})

test('a real change swaps the snapshot and notifies once', async () => {
  const harness = createHarness()
  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const first = harness.client.getSnapshot()

  harness.post({ type: 'snapshot', snapshot: snapshot({ isStreaming: true }), subagentProgress: [] })
  await settle()

  assert.notEqual(harness.client.getSnapshot(), first)
  assert.equal(harness.client.getSnapshot().isStreaming, true)
  assert.equal(notifications, 2)
  harness.client.dispose()
})

test('usage is compared by value, so identical totals keep their identity', async () => {
  const harness = createHarness()
  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const firstUsage = harness.client.getSnapshot().usage

  harness.post({
    type: 'snapshot',
    snapshot: snapshot({ spinnerSubText: 'Running Bash' }),
    subagentProgress: [],
  })
  await settle()

  assert.equal(harness.client.getSnapshot().usage, firstUsage,
    'an unrelated change must not hand consumers a new usage object')
  assert.equal(harness.client.getSnapshot().spinnerSubText, 'Running Bash')
  harness.client.dispose()
})

test('subagent progress is rehydrated into a Map', async () => {
  const harness = createHarness()
  harness.post({
    type: 'snapshot',
    snapshot: snapshot(),
    subagentProgress: [['agent-1', 'Reading'], ['agent-2', 'Searching']],
  })
  await settle()

  assert.equal(harness.client.getSubagentProgress().get('agent-2'), 'Searching')
  harness.client.dispose()
})

test('session events reach onEvent listeners untouched', async () => {
  const harness = createHarness()
  const seen: SessionEvent[] = []
  harness.client.onEvent((event) => seen.push(event))

  harness.post({
    type: 'session-event',
    event: { type: 'notice', level: 'error', content: 'boom' },
  })
  await settle()

  assert.deepEqual(seen, [{ type: 'notice', level: 'error', content: 'boom' }])
  harness.client.dispose()
})

test('a command resolves on reply and rejects on fail', async () => {
  const harness = createHarness()

  const pending = harness.client.setEffort('low')
  await settle()
  const command = harness.sent.find((entry) => entry.type === 'set-effort')
  assert.ok(command && command.type === 'set-effort')
  assert.equal(command.persist, undefined, 'persistence is opt-in')
  harness.post({ type: 'reply', id: command.id, result: { effort: 'low', persisted: false } })
  assert.deepEqual(await pending, { effort: 'low', persisted: false })

  const failing = harness.client.setModel('nope')
  await settle()
  const second = harness.sent.find((entry) => entry.type === 'set-model')
  assert.ok(second && second.type === 'set-model')
  harness.post({ type: 'fail', id: second.id, message: 'Unknown model' })
  await assert.rejects(failing, /Unknown model/)
  harness.client.dispose()
})

test('a dead host rejects every in-flight command instead of hanging the UI', async () => {
  const harness = createHarness()
  // Assertions are attached before the close so the rejections are never
  // momentarily unhandled.
  const first = assert.rejects(harness.client.reload(), /host disconnected/)
  const second = assert.rejects(harness.client.getCheckpoints(), /host disconnected/)
  await settle()

  harness.hostSide.close()

  await first
  await second
})

test('with no handler installed, UI requests answer the way a missing UI would', async () => {
  const harness = createHarness()

  harness.post({ type: 'ui-request', request: { kind: 'permission', requestId: 'r1', payload: {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: {},
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: false,
    destructiveWarnings: [],
  } } })
  harness.post({ type: 'ui-request', request: { kind: 'enter-plan', requestId: 'r2' } })
  await settle()
  await settle()

  const responses = harness.sent.filter((entry) => entry.type === 'ui-response')
  assert.equal(responses.length, 2, 'an unanswered request would hang the agent loop')

  const permission = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r1')
  assert.ok(permission && permission.type === 'ui-response'
    && permission.response.kind === 'permission')
  assert.equal(permission.response.approved, false)

  const enterPlan = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r2')
  assert.ok(enterPlan && enterPlan.type === 'ui-response'
    && enterPlan.response.kind === 'enter-plan')
  assert.equal(enterPlan.response.approved, true, 'same asymmetry as the host fallbacks')
  harness.client.dispose()
})

test('an installed permission handler can answer with alwaysAllow', async () => {
  const harness = createHarness()
  harness.client.setHandlers({
    permission: async () => ({ approved: true, alwaysAllow: true }),
  })

  harness.post({ type: 'ui-request', request: { kind: 'permission', requestId: 'r1', payload: {
    toolName: 'Read',
    riskLevel: 'safe',
    input: {},
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: true,
    destructiveWarnings: [],
  } } })
  await settle()
  await settle()

  const response = harness.sent.find((entry) => entry.type === 'ui-response')
  assert.ok(response && response.type === 'ui-response' && response.response.kind === 'permission')
  assert.deepEqual(response.response, { kind: 'permission', approved: true, alwaysAllow: true })
  harness.client.dispose()
})

test('an unchanged background task list keeps its identity', async () => {
  const harness = createHarness()
  const post = (outputBytes: number) => harness.post({
    type: 'background-tasks',
    tasks: [{ id: 't1', status: 'running', outputBytes, unreadBytes: 4 }],
  } as unknown as HostEvent)

  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  post(10)
  await settle()
  const first = harness.client.getBackgroundTasks()
  assert.equal(first.length, 1)
  assert.equal(notifications, 1)

  // The host re-sends the whole list on every change, so an identical payload
  // must not hand useSyncExternalStore a new array.
  post(10)
  await settle()
  assert.equal(harness.client.getBackgroundTasks(), first, 'identity must survive an identical list')
  assert.equal(notifications, 1, 'and it must not notify')

  post(11)
  await settle()
  assert.notEqual(harness.client.getBackgroundTasks(), first)
  assert.equal(notifications, 2)
  harness.client.dispose()
})

test('shutdown resolves even when the host dies before replying', async () => {
  const harness = createHarness()

  const closing = harness.client.shutdown('window closed')
  await settle()
  harness.hostSide.close()

  // The host going away is the success case; a window must not refuse to close
  // because the reply never arrived.
  await closing
  harness.client.dispose()
})

test('the two rewind commands unwrap to the records the host wrote', async () => {
  const harness = createHarness()

  const truncating = harness.client.truncateSession('m3')
  await settle()
  const truncate = harness.sent.find((entry) => entry.type === 'truncate-session')
  assert.ok(truncate && truncate.type === 'truncate-session')
  assert.equal(truncate.messageId, 'm3')
  harness.post({ type: 'reply', id: truncate.id, result: { records: [{ id: 'm1' }] } })
  assert.deepEqual(await truncating, [{ id: 'm1' }])

  const summarizing = harness.client.summarizeRewind('m3', 'summarize-up-to-here')
  await settle()
  const summarize = harness.sent.find((entry) => entry.type === 'summarize-rewind')
  assert.ok(summarize && summarize.type === 'summarize-rewind')
  assert.equal(summarize.decision, 'summarize-up-to-here')
  harness.post({ type: 'reply', id: summarize.id, result: { records: [] } })
  assert.deepEqual(await summarizing, [])
  harness.client.dispose()
})

test('a rewind that cannot happen rejects rather than resolving empty', async () => {
  const harness = createHarness()
  const pending = assert.rejects(harness.client.truncateSession('gone'), /Message not found/)
  await settle()

  const sent = harness.sent.find((entry) => entry.type === 'truncate-session')
  assert.ok(sent)
  harness.post({ type: 'fail', id: sent.id, message: 'Message not found: gone' })
  await pending
  harness.client.dispose()
})

test('retarget returns the session alongside its records', async () => {
  const harness = createHarness()
  const pending = harness.client.retarget('s2')
  await settle()

  const sent = harness.sent.find((entry) => entry.type === 'retarget')
  assert.ok(sent && sent.type === 'retarget')
  harness.post({
    type: 'reply',
    id: sent.id,
    result: { session: { id: 's2' }, records: [], notices: [] },
  })

  const result = await pending
  assert.equal(result.session.id, 's2')
  assert.deepEqual(result.records, [])
  harness.client.dispose()
})
