import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import type { HostCommand, HostEvent } from '../src/runtime/protocol/wire.js'
import type { SessionController, SessionEvent } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { RuntimeHost } from '../src/runtime/types.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'
import { SessionStore } from '../src/sessions/service.js'

/**
 * The host is exercised against stub collaborators rather than a real runtime:
 * what matters here is the boundary contract — what crosses, in what order, and
 * what happens to outstanding questions when the client dies — not the loop.
 */

interface Harness {
  host: SessionHost
  received: HostEvent[]
  send: (command: HostCommand) => void
  emit: (event: SessionEvent) => void
  publishSnapshot: () => void
  bridges: ReturnType<typeof createUiBridges>
  calls: {
    submits: string[]
    interrupts: unknown[]
    createdRuntimes: Array<{ modelKey: string; recordCount: number }>
  }
  closeClient: () => void
  dispose: () => void
}

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-protocol-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('protocol test')

  const bridges = createUiBridges()
  const calls: Harness['calls'] = { submits: [], interrupts: [], createdRuntimes: [] }

  const eventListeners = new Set<(event: SessionEvent) => void>()
  const snapshotListeners = new Set<() => void>()
  let snapshot = {
    isStreaming: false,
    usage: { lastRequest: null, total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } },
    taskSnapshot: undefined,
    spinnerSubText: undefined,
  }

  const controller = {
    onEvent: (listener: (event: SessionEvent) => void) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    subscribe: (listener: () => void) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getSubagentProgress: () => new Map([['agent-1', 'Reading file']]),
    submit: async (input: string) => { calls.submits.push(input) },
    interrupt: (reason: unknown) => { calls.interrupts.push(reason) },
    reload: async () => [] as SessionRecord[],
    retarget: () => {},
    getCheckpointService: () => ({
      getCheckpointsWithDiffs: async () => [{ messageId: 'm1', commitHash: 'abc' }],
      restoreToCommit: async (hash: string) => ({ success: true, commitHash: hash }),
    }),
  }

  const loop = { runTool: async () => ({ ok: true, content: 'ran' }), clearCachedSections: () => {} }
  const agentSession = {
    loop,
    planModeManager: undefined,
    modelKey: 'main',
    modelConfig: { model: 'test-model', contextWindow: 200_000, maxEffort: 'high', apiKey: 'SECRET' },
    providerName: 'anthropic',
  }
  const runtimeSlot = {
    current: agentSession,
    subscribe: () => () => {},
    getEffort: () => 'high',
    setEffort: (level: string) => level,
    reapplyEffort: () => 'high',
    replace: () => {},
  }

  const runtimeHost = {
    cwd,
    session,
    store,
    bridges,
    existingRecords: [] as SessionRecord[],
    permissionGate: { getMode: () => 'default' },
    createRuntime: (modelKey: string, _session: unknown, records?: readonly SessionRecord[]) => {
      calls.createdRuntimes.push({ modelKey, recordCount: records?.length ?? 0 })
      return agentSession
    },
    createActiveModelRuntime: (modelKey: string) => ({ model: modelKey, provider: {} }),
  }

  const [hostSide, clientSide] = createMemoryChannelPair()
  const received: HostEvent[] = []
  clientSide.onMessage((message) => received.push(message as HostEvent))

  const host = new SessionHost({
    channel: hostSide,
    controller: controller as unknown as SessionController,
    runtimeSlot: runtimeSlot as unknown as RuntimeSlot,
    host: runtimeHost as unknown as RuntimeHost,
  })

  return {
    host,
    received,
    send: (command) => clientSide.post(command),
    emit: (event) => { for (const listener of [...eventListeners]) listener(event) },
    publishSnapshot: () => {
      snapshot = { ...snapshot, isStreaming: !snapshot.isStreaming }
      for (const listener of [...snapshotListeners]) listener()
    },
    bridges,
    calls,
    closeClient: () => clientSide.close(),
    dispose: () => host.dispose(),
  }
}

/** The memory channel delivers on a microtask; give it a macrotask to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** For commands that touch disk, where one macrotask is not enough. */
async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const fakeTool = { name: 'Bash', riskLevel: 'confirm' } as unknown as Tool

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: fakeTool,
    input: { command: 'ls' },
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    ...overrides,
  } as PermissionRequest
}

test('session events are forwarded to the client in order', async () => {
  const harness = await createHarness()
  harness.emit({ type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' })
  harness.emit({ type: 'turn-end', aborted: false, rolledBack: false, durationMs: 5 })
  await settle()

  const events = harness.received.filter((event) => event.type === 'session-event')
  assert.deepEqual(events.map((event) => event.event.type), ['turn-start', 'turn-end'])
  harness.dispose()
})

test('snapshots carry subagent progress, which cannot cross as a Map', async () => {
  const harness = await createHarness()
  harness.publishSnapshot()
  await settle()

  const snapshot = harness.received.find((event) => event.type === 'snapshot')
  assert.ok(snapshot && snapshot.type === 'snapshot')
  assert.deepEqual(snapshot.subagentProgress, [['agent-1', 'Reading file']])
  harness.dispose()
})

test('hello replays both snapshots and never leaks the model apiKey', async () => {
  const harness = await createHarness()
  harness.send({ type: 'hello', id: 'c1' })
  await settle()

  const runtime = harness.received.find((event) => event.type === 'runtime-snapshot')
  assert.ok(runtime && runtime.type === 'runtime-snapshot')
  assert.equal(runtime.snapshot.modelKey, 'main')
  assert.equal(runtime.snapshot.model, 'test-model')
  assert.equal(runtime.snapshot.permissionMode, 'default')
  assert.equal(JSON.stringify(runtime.snapshot).includes('SECRET'), false,
    'the endpoint credential must never reach a renderer')

  assert.ok(harness.received.some((event) => event.type === 'snapshot'))
  assert.ok(harness.received.some((event) => event.type === 'reply' && event.id === 'c1'))
  harness.dispose()
})

test('interrupt crosses as a reason sentinel, not a signal', async () => {
  const harness = await createHarness()
  harness.send({ type: 'interrupt', id: 'c1', reason: 'user-cancel' })
  harness.send({ type: 'interrupt', id: 'c2', reason: 'exit' })
  await settle()

  // 'exit' deliberately misses isUserCancelAbort, so quitting writes no
  // turn_interruption record; both sentinels have to survive the boundary.
  assert.deepEqual(harness.calls.interrupts, ['user-cancel', 'exit'])
  harness.dispose()
})

test('a permission prompt becomes a DTO without the Tool or the callback', async () => {
  const harness = await createHarness()
  let alwaysAllowFired = false
  const pending = harness.bridges.prompt.prompt(permissionRequest({
    onAlwaysAllow: () => { alwaysAllowFired = true },
  }))
  await settle()

  const request = harness.received.find((event) => event.type === 'ui-request')
  assert.ok(request && request.type === 'ui-request' && request.request.kind === 'permission')
  assert.deepEqual(request.request.payload, {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: { command: 'ls' },
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: true,
    // Derived host-side so a renderer can draw the dialog without the harness.
    destructiveWarnings: [],
  })

  harness.send({
    type: 'ui-response',
    requestId: request.request.requestId,
    response: { kind: 'permission', approved: true, alwaysAllow: true },
  })

  assert.equal(await pending, true)
  assert.equal(alwaysAllowFired, true,
    'onAlwaysAllow must fire before the approval resolves; the gate reads the flag right after')
  harness.dispose()
})

test('a lost client settles each outstanding request with its own fallback', async () => {
  const harness = await createHarness()
  const permission = harness.bridges.prompt.prompt(permissionRequest())
  const enterPlan = harness.bridges.enterPlan.open()
  const exitPlan = harness.bridges.exitPlan.open({ planContent: 'p', planFilePath: 'p.md' })
  const question = harness.bridges.askUserQuestion.ask({ questions: [] })
  await settle()

  harness.closeClient()
  await settle()

  // Nothing else unblocks these: ToolRunner does not pass its abort signal into
  // PermissionGate.approve, so without this the loop waits forever.
  assert.equal(await permission, false, 'permission denies')
  assert.equal(await enterPlan, true, 'entering plan mode approves')
  assert.equal((await exitPlan).kind, 'reject', 'exiting plan mode rejects')
  assert.equal((await question).kind, 'rejected', 'AskUserQuestion rejects')
})

test('switching models passes the accumulated record ledger to the new runtime', async () => {
  const harness = await createHarness()
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
  })
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  })
  // The same record arriving twice must not be counted twice.
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  })
  await settle()

  harness.send({ type: 'set-model', id: 'c1', modelKey: 'other' })
  await settle()

  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'other', recordCount: 2 }],
    'createRuntime folds records into task state, so a stale list loses them')
  harness.dispose()
})

test('a failing command replies with fail rather than hanging the client', async () => {
  const harness = await createHarness()
  harness.send({ type: 'retarget', id: 'c1', sessionId: 'does-not-exist' })

  const failure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail'),
    'a fail reply',
  )
  assert.ok(failure.type === 'fail')
  assert.equal(failure.id, 'c1')
  assert.match(failure.message, /Unknown session/)
  harness.dispose()
})

test('dispose stops forwarding and releases the bridges', async () => {
  const harness = await createHarness()
  harness.dispose()

  harness.emit({ type: 'restore-input', text: 'x' })
  await settle()
  assert.equal(harness.received.length, 0)

  // The prompt bridge is detached, not left pointing at a dead channel, so the
  // next UI to attach picks the request up.
  let settled: boolean | undefined
  void harness.bridges.prompt.prompt(permissionRequest()).then((value) => { settled = value })
  await settle()
  assert.equal(settled, undefined)
})
