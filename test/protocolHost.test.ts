import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { registerBuiltinCommands } from '../src/commands/index.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import type { HostCommand, HostEvent } from '../src/runtime/protocol/wire.js'
import type { SessionController, SessionEvent } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
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
  /** Malformed payloads, which `send` is deliberately too well typed to express. */
  sendRaw: (message: unknown) => void
  emit: (event: SessionEvent) => void
  publishSnapshot: () => void
  bridges: ReturnType<typeof createUiBridges>
  /** The real store behind the stub controller, for the commands that write. */
  store: SessionStore
  sessionId: string
  calls: {
    submits: string[]
    interrupts: unknown[]
    createdRuntimes: Array<{ modelKey: string; recordCount: number }>
    defaultModels: string[]
    shutdowns: string[]
    modeChanges: string[]
    cacheInvalidations: number
    summarized: SessionRecord[][]
  }
  /** Drives the two subscriptions the host installs on the runtime host. */
  changeMode: (mode: string) => void
  getPermissionMode: () => string
  changeBackgroundTasks: (tasks: unknown[]) => void
  closeClient: () => void
  dispose: () => void
}

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-protocol-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('protocol test')

  const bridges = createUiBridges()
  const calls: Harness['calls'] = {
    submits: [],
    interrupts: [],
    createdRuntimes: [],
    defaultModels: [],
    shutdowns: [],
    modeChanges: [],
    cacheInvalidations: 0,
    summarized: [],
  }

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
    // Reads the real store and emits the reset the real controller emits, so a
    // command that rewrote the file on disk is observable through the boundary.
    reload: async () => {
      const loaded = await store.loadRecordsWithDiagnostics(session.id)
      for (const listener of [...eventListeners]) {
        listener({ type: 'transcript-reset', records: loaded.records, systemMessages: [], bumpGeneration: true })
      }
      return loaded.records
    },
    retarget: () => {},
    getCheckpointService: () => ({
      getCheckpointsWithDiffs: async () => [{ messageId: 'm1', commitHash: 'abc' }],
      restoreToCommit: async (hash: string) => ({ success: true, commitHash: hash }),
    }),
  }

  const loop = {
    runTool: async () => ({ ok: true, content: 'ran' }),
    clearCachedSections: () => {},
    invalidateRecordsCache: () => { calls.cacheInvalidations += 1 },
    summarizeRecordsForRewind: async (records: SessionRecord[]) => {
      calls.summarized.push(records)
      return { summary: `summary of ${records.length}`, preTokens: 1234 }
    },
  }
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

  const modeListeners = new Set<(mode: string) => void>()
  const taskListeners = new Set<() => void>()
  let backgroundTaskSnapshot: unknown[] = []
  let permissionMode = 'default'

  const runtimeHost = {
    cwd,
    session,
    store,
    bridges,
    existingRecords: [] as SessionRecord[],
    diagnostics: [],
    mcp: { connected: [], failed: [] },
    hasRecoverableInterruption: false,
    configuredEffortLevel: 'medium',
    permissionGate: {
      getMode: () => permissionMode,
      setMode: (mode: string) => { permissionMode = mode; calls.modeChanges.push(mode) },
      prepareContextForPlanMode: () => { permissionMode = 'plan'; calls.modeChanges.push('plan') },
      onModeChange: (listener: (mode: string) => void) => {
        modeListeners.add(listener)
        return () => modeListeners.delete(listener)
      },
    },
    backgroundTasks: {
      subscribe: (listener: () => void) => {
        taskListeners.add(listener)
        return () => taskListeners.delete(listener)
      },
      getSnapshot: () => backgroundTaskSnapshot,
      restoreSession: async () => [] as string[],
      stopAll: async () => {},
      peekOutput: () => 'tail of the output',
      killShell: async (_sessionId: string, taskId: string) => ({ id: taskId, status: 'killed' }),
    },
    config: {
      get: () => ({
        models: { main: {}, fast: {}, broken: {} },
        defaultModel: 'main',
      }),
      getModel: (key: string) => (key === 'broken'
        ? undefined
        : {
          model: `${key}-model`,
          provider: 'anthropic',
          contextWindow: 200_000,
          maxEffort: 'high',
          // Present exactly as resolveModel would fold them in.
          apiKey: 'SECRET',
          baseUrl: 'https://secret.example.com',
        }),
      resolveModelInput: (input: string) => {
        if (input === 'nope') return undefined
        // A real key resolves to itself; anything else gets a marker suffix so a
        // test can tell "resolved" from "was already a key".
        return input in { main: 1, fast: 1, broken: 1 } ? input : `${input}-resolved`
      },
      findTierForModel: (modelKey: string) => (modelKey === 'fast' ? 'fast' : undefined),
      resolveModelReference: (reference: string | undefined) => reference,
      getActiveProfile: () => ({
        name: 'default',
        profile: { fast: 'fast', balanced: 'main', powerful: 'main' },
      }),
      setDefaultModel: (name: string) => { calls.defaultModels.push(name) },
      save: async () => {},
    },
    reloadAgentDefinitions: async () => 3,
    reloadSkills: async () => 4,
    reloadSettings: async () => ({ needsRuntimeRebuild: false }),
    shutdown: async (reason: string) => { calls.shutdowns.push(reason) },
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
    // One fake satisfies both halves: `RuntimeHost` *is* their intersection, so
    // a single-session host sees exactly what it used to.
    project: runtimeHost as unknown as ProjectRuntime,
    scope: runtimeHost as unknown as SessionScope,
  })

  return {
    host,
    received,
    send: (command) => clientSide.post(command),
    sendRaw: (message) => clientSide.post(message),
    emit: (event) => { for (const listener of [...eventListeners]) listener(event) },
    publishSnapshot: () => {
      snapshot = { ...snapshot, isStreaming: !snapshot.isStreaming }
      for (const listener of [...snapshotListeners]) listener()
    },
    bridges,
    store,
    sessionId: session.id,
    calls,
    changeMode: (mode: string) => { for (const listener of [...modeListeners]) listener(mode) },
    getPermissionMode: () => permissionMode,
    changeBackgroundTasks: (tasks: unknown[]) => {
      backgroundTaskSnapshot = tasks
      for (const listener of [...taskListeners]) listener()
    },
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

/** Three user/assistant messages on disk, so a rewind has something to cut. */
async function seedConversation(harness: Harness): Promise<void> {
  const records: SessionRecord[] = [
    { type: 'message', id: 'm1', role: 'user', content: 'first', createdAt: 'now' },
    { type: 'message', id: 'm2', role: 'assistant', content: 'answer one', createdAt: 'now' },
    { type: 'message', id: 'm3', role: 'user', content: 'second', createdAt: 'now' },
    { type: 'message', id: 'm4', role: 'assistant', content: 'answer two', createdAt: 'now' },
  ]
  for (const record of records) await harness.store.appendRecord(harness.sessionId, record)
}

test('truncate-session cuts the file, repaints the view and rebases the ledger', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm3' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.id), ['m1', 'm2'],
    'truncateBeforeMessage keeps records strictly before the target')

  // The event stream, not the reply, is what a view listens to.
  const reset = harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'transcript-reset',
  )
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.deepEqual(reset.event.records.map((record) => record.id), ['m1', 'm2'])

  assert.equal(harness.calls.cacheInvalidations, 1,
    'without this the loop keeps serving the records it read before the cut')

  // A stale ledger would fold the discarded records into the next runtime.
  harness.send({ type: 'set-model', id: 'c2', modelKey: 'other' })
  await settle()
  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'other', recordCount: 2 }])
  harness.dispose()
})

test('truncate-session fails loudly for a message that is not in the session', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'gone' })
  const failure = await waitFor(() => harness.received.find((event) => event.type === 'fail'), 'a fail reply')
  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /Message not found/)
  // Reporting success here would leave the caller showing a transcript the file
  // no longer matches.
  assert.equal(harness.received.some((event) => event.type === 'reply'), false)
  harness.dispose()
})

test('summarize-rewind replaces the earlier half with a boundary', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision: 'summarize-up-to-here' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.type),
    ['compact_boundary', 'message', 'message'])
  assert.deepEqual(records.slice(1).map((record) => record.id), ['m3', 'm4'])

  const boundary = records[0]
  assert.ok(boundary?.type === 'compact_boundary')
  assert.equal(boundary.summary, 'summary of 2')
  assert.equal(boundary.preTokens, 1234)

  // The summary must come from the loop, which is the only thing that can call
  // the provider -- and it arrives with exactly the records being replaced.
  assert.deepEqual(harness.calls.summarized.map((batch) => batch.map((record) => record.id)), [['m1', 'm2']])

  // Persisted, not just returned.
  const onDisk = await harness.store.loadRecordsWithDiagnostics(harness.sessionId)
  assert.deepEqual(onDisk.records.map((record) => record.type),
    ['compact_boundary', 'message', 'message'])
  harness.dispose()
})

test('summarize-rewind summarizes the later half for the other decision', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision: 'summarize-from-here' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.type), ['message', 'message', 'compact_boundary'])
  assert.deepEqual(harness.calls.summarized.map((batch) => batch.map((record) => record.id)), [['m3', 'm4']])
  harness.dispose()
})

test('summarize-rewind refuses a target with nothing on the far side', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  // Nothing precedes m1, so there is no earlier conversation to summarize.
  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm1', decision: 'summarize-up-to-here' })
  const failure = await waitFor(() => harness.received.find((event) => event.type === 'fail'), 'a fail reply')
  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /No earlier conversation/)
  assert.equal(harness.calls.summarized.length, 0, 'no provider call for a rewind that cannot happen')
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

/** Effects and the reply share one channel; this reads them back in arrival order. */
function commandTraffic(harness: Harness): string[] {
  return harness.received.flatMap((event) => {
    if (event.type === 'command-effect') return [`effect:${event.effect.kind}`]
    if (event.type === 'reply') return ['reply']
    if (event.type === 'fail') return ['fail']
    return []
  })
}

test('a slash command\'s effects all arrive before its reply', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/help' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // This ordering is the whole reason run-command needs an event channel: /help
  // pushes its view while it is still running.
  assert.deepEqual(commandTraffic(harness), ['effect:open-command-view', 'reply'])

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'open-command-view')
  assert.equal(effect.effect.view.kind, 'list')
  harness.dispose()
})

test('input that is not a slash command comes back unhandled', async () => {
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: 'just a prompt' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: false })
  assert.equal(harness.received.some((event) => event.type === 'command-effect'), false)
  harness.dispose()
})

test('an unknown command is handled, and explains itself as a written line', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/nosuchthing' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // Same tolerance as the TUI's dispatch: a bad command name is not a protocol
  // failure, so this must not be a `fail`.
  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true })
  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /Unknown command: \/nosuchthing/)
  harness.dispose()
})

test('/exit asks the shell to close rather than shutting the host down', async () => {
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/exit' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true, exit: true })
  assert.deepEqual(harness.calls.shutdowns, [],
    'the shell owns its teardown; it calls shutdown when it is ready')
  harness.dispose()
})

test('a command that throws is reported through a written line, not a fail', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()
  // Two agents sharing a prefix: `resolveAgentId` refuses to guess and throws,
  // which is a genuine throw out of `command.run` rather than a handled miss.
  for (const agentId of ['abc111', 'abc222']) {
    await harness.store.appendRecord(harness.sessionId, {
      type: 'subagent_task',
      id: `r-${agentId}`,
      agentId,
      subagentType: 'general',
      status: 'completed',
      description: 'd',
      task: 't',
      createdAt: 'now',
    } as SessionRecord)
  }

  harness.send({ type: 'run-command', id: 'c1', input: '/agents show abc' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // Same tolerance as the TUI's dispatch: the command failed, the protocol did not.
  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true })
  assert.equal(harness.received.some((event) => event.type === 'fail'), false)

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /Command error: Ambiguous subagent id abc/)
  harness.dispose()
})

test('/model with an argument switches the runtime and persists the tier', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/model fast' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'fast', recordCount: 0 }])
  // The tier write-back is what separates /model from the set-model command.
  assert.deepEqual(harness.calls.defaultModels, ['fast'])
  harness.dispose()
})

test('/model with an unknown argument writes a line and leaves the runtime alone', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/model nope' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.createdRuntimes, [])
  assert.deepEqual(harness.calls.defaultModels, [])
  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /Unknown model or tier: nope/)
  harness.dispose()
})

test('/model with no argument asks for the picker', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/model' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'open-surface')
  assert.equal(effect.effect.surface, 'model-picker')
  harness.dispose()
})

test('/clear switches to a fresh session and announces it', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
  })
  await settle()

  harness.send({ type: 'run-command', id: 'c1', input: '/clear' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  const changed = harness.received.find((event) => event.type === 'session-changed')
  assert.ok(changed?.type === 'session-changed')
  assert.notEqual(changed.session.id, harness.sessionId,
    'without this a client keeps its message queue keyed to the session it left')

  const reset = harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'transcript-reset',
  )
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.deepEqual(reset.event.records, [])

  // The ledger went with it: the next runtime must not inherit the old records.
  harness.send({ type: 'set-model', id: 'c2', modelKey: 'other' })
  await settle()
  const forModel = harness.calls.createdRuntimes.at(-1)
  assert.equal(forModel?.recordCount, 0)
  harness.dispose()
})

test('/plan reaches the permission gate', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/plan' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.modeChanges, ['plan'])
  assert.equal(harness.getPermissionMode(), 'plan')
  harness.dispose()
})

test('the command context reads the session through a getter, not a capture', async () => {
  registerBuiltinCommands()
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/clear' })
  const changed = await waitFor(
    () => harness.received.find((event) => event.type === 'session-changed'),
    'the session-changed event',
  )
  assert.ok(changed.type === 'session-changed')
  const newSessionId = changed.session.id

  // /session prints context.sessionId. A captured id would still name the
  // session /clear left behind.
  harness.send({ type: 'run-command', id: 'c2', input: '/session' })
  await waitFor(
    () => (harness.received.filter((event) => event.type === 'reply').length === 2 ? true : undefined),
    'the second reply',
  )

  const views = harness.received.filter((event) =>
    event.type === 'command-effect' && event.effect.kind === 'open-command-view')
  const view = views[views.length - 1]
  assert.ok(view?.type === 'command-effect' && view.effect.kind === 'open-command-view')
  assert.equal(view.effect.view.kind, 'info')
  const rows = view.effect.view.kind === 'info' ? view.effect.view.sections[0]?.rows : undefined
  assert.equal(rows?.find((row: { label: string }) => row.label === 'Session ID')?.value, newSessionId)
  assert.notEqual(newSessionId, harness.sessionId)
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

test('a plan-mode change reaches the client even though it never touches RuntimeSlot', async () => {
  const harness = await createHarness()
  const before = harness.received.filter((event) => event.type === 'runtime-snapshot').length

  // EnterPlanMode/ExitPlanMode drive PermissionGate directly, so without an
  // onModeChange subscription the client's permission mode goes stale.
  harness.changeMode('plan')
  await settle()

  const after = harness.received.filter((event) => event.type === 'runtime-snapshot').length
  assert.equal(after, before + 1)
  harness.dispose()
})

test('background task updates are coalesced into one message per macrotask', async () => {
  const harness = await createHarness()
  const before = harness.received.filter((event) => event.type === 'background-tasks').length

  // changed() fires on every output chunk of every running shell.
  for (let i = 0; i < 50; i += 1) harness.changeBackgroundTasks([{ id: 't1', outputBytes: i }])
  await settle()

  const posts = harness.received.filter((event) => event.type === 'background-tasks')
  assert.equal(posts.length - before, 1, '50 changes must collapse to one post')
  const last = posts.at(-1)
  assert.ok(last?.type === 'background-tasks')
  assert.deepEqual(last.tasks, [{ id: 't1', outputBytes: 49 }])
  harness.dispose()
})

test('the model list never carries an apiKey or a baseUrl', async () => {
  const harness = await createHarness()
  harness.send({ type: 'list-models', id: 'm1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'm1'),
    'a model list',
  )
  assert.ok(reply.type === 'reply')
  const serialized = JSON.stringify(reply.result)
  assert.ok(!serialized.includes('SECRET'), 'apiKey must not cross the boundary')
  assert.ok(!serialized.includes('secret.example.com'), 'baseUrl must not cross the boundary')

  const result = reply.result as {
    models: Array<{ key: string; model?: string }>
    defaultModelKey?: string
    pickerOptions: Array<{ tier: string; modelKey?: string; disabledReason?: string }>
  }
  assert.deepEqual(result.models.map((entry) => entry.key), ['main', 'fast', 'broken'])
  assert.equal(result.models[0]?.model, 'main-model')
  // An unresolvable entry still appears, matching availableModelKeys.
  assert.equal(result.models[2]?.model, undefined)
  assert.equal(result.defaultModelKey, 'main')

  // The picker rides along, resolved host-side because building it needs
  // getModel -- the same call that folds the secrets in above. Asserted
  // non-empty so the serialized check is not passing over an empty array.
  assert.deepEqual(result.pickerOptions.map((option) => option.tier), ['fast', 'balanced', 'powerful'])
  assert.deepEqual(result.pickerOptions.map((option) => option.modelKey), ['fast', 'main', 'main'])
  harness.dispose()
})

test('hello carries everything a shell needs to paint its first frame', async () => {
  const harness = await createHarness()
  harness.send({ type: 'hello', id: 'h1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'h1'),
    'a hello reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as {
    sessionId: string
    session: { id: string }
    cwd: string
    records: SessionRecord[]
    notices: unknown[]
    hasRecoverableInterruption: boolean
    configuredEffortLevel: string
  }
  assert.equal(result.session.id, result.sessionId)
  assert.equal(typeof result.cwd, 'string')
  assert.deepEqual(result.records, [])
  assert.deepEqual(result.notices, [])
  assert.equal(result.hasRecoverableInterruption, false)
  assert.equal(result.configuredEffortLevel, 'medium')
  harness.dispose()
})

test('switching sessions rebuilds the runtime and resets the transcript', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length

  harness.send({ type: 'create-session', id: 'c1', title: 'fresh' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'),
    'a create-session reply',
  )

  assert.ok(reply.type === 'reply')
  const result = reply.result as { session: { id: string }; records: SessionRecord[] }
  assert.deepEqual(result.records, [])
  assert.notEqual(result.session.id, undefined)

  // Retargeting the controller alone would leave the loop bound to the old
  // session, so a switch must go through createRuntime + RuntimeSlot.replace.
  assert.equal(harness.calls.createdRuntimes.length, created + 1)

  const reset = harness.received.find((event) =>
    event.type === 'session-event' && event.event.type === 'transcript-reset')
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.equal(reset.event.bumpGeneration, true)
  harness.dispose()
})

test('retargeting an unknown session fails instead of half-switching', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length

  harness.send({ type: 'retarget', id: 'r1', sessionId: 'does-not-exist' })
  const failure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'r1'),
    'a fail reply',
  )

  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /Unknown session/)
  assert.equal(harness.calls.createdRuntimes.length, created)
  harness.dispose()
})

test('the reload commands forward to the host and report their counts', async () => {
  const harness = await createHarness()
  harness.send({ type: 'reload-agents', id: 'a1' })
  harness.send({ type: 'reload-skills', id: 's1' })
  harness.send({ type: 'reload-settings', id: 'g1' })

  const agents = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'a1'), 'reload-agents')
  const skills = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 's1'), 'reload-skills')
  const settings = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'g1'), 'reload-settings')

  assert.ok(agents.type === 'reply' && skills.type === 'reply' && settings.type === 'reply')
  assert.deepEqual(agents.result, { count: 3 })
  assert.deepEqual(skills.result, { count: 4 })
  assert.deepEqual(settings.result, { needsRuntimeRebuild: false, rebuilt: false, modelKey: 'main' })
  harness.dispose()
})

test('set-effort only persists when asked, and shutdown replies before the window closes', async () => {
  const harness = await createHarness()
  harness.send({ type: 'set-effort', id: 'e1', level: 'low' })
  const effort = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'e1'), 'set-effort')
  assert.ok(effort.type === 'reply')
  // No persist flag, so settings on disk are untouched.
  assert.deepEqual(effort.result, { effort: 'low', persisted: false })

  harness.send({ type: 'shutdown', id: 'x1', reason: 'window closed' })
  const bye = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'x1'), 'shutdown')
  assert.ok(bye.type === 'reply')
  assert.deepEqual(harness.calls.shutdowns, ['window closed'])
  harness.dispose()
})

test('background task commands read and kill through the registry', async () => {
  const harness = await createHarness()
  harness.send({ type: 'peek-task-output', id: 'p1', taskId: 't1' })
  harness.send({ type: 'kill-task', id: 'k1', taskId: 't1', reason: 'user asked' })

  const peeked = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'p1'), 'peek')
  const killed = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'k1'), 'kill')

  assert.ok(peeked.type === 'reply' && killed.type === 'reply')
  assert.deepEqual(peeked.result, { output: 'tail of the output' })
  assert.deepEqual(killed.result, { task: { id: 't1', status: 'killed' } })
  harness.dispose()
})

test('an unrecognized command fails instead of replying that it worked', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'bogus', id: 'c1' })
  await settle()

  const answers = harness.received.filter((event) => event.type === 'fail' || event.type === 'reply')
  assert.equal(answers.length, 1)
  // The old blind cast let this fall out of the switch in execute(), which
  // answered `{ type: 'reply', result: undefined }` -- a command that had done
  // nothing, reported as a success.
  assert.equal(answers[0]?.type, 'fail')
  assert.equal(answers[0] && 'id' in answers[0] ? answers[0].id : undefined, 'c1')
  harness.dispose()
})

test('a malformed permission mode is refused rather than applied', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'set-permission-mode', id: 'c1', mode: 'god' })
  await settle()

  const fail = harness.received.find((event) => event.type === 'fail')
  assert.ok(fail && fail.type === 'fail')
  assert.match(fail.message, /mode/)
  // The point of validating at all: in an Electron shell the renderer is the
  // less trusted half, and this command reaches PermissionGate directly.
  assert.deepEqual(harness.calls.modeChanges, [])

  harness.send({ type: 'set-permission-mode', id: 'c2', mode: 'bypass' })
  await settle()
  assert.deepEqual(harness.calls.modeChanges, ['bypass'], 'a legal mode still applies')
  harness.dispose()
})

test('a malformed ui-response settles the prompt with its own fallback', async () => {
  const harness = await createHarness()
  const permission = harness.bridges.prompt.prompt(permissionRequest())
  const enterPlan = harness.bridges.enterPlan.open()
  await settle()

  const requests = harness.received.filter((event) => event.type === 'ui-request')
  for (const event of requests) {
    assert.ok(event.type === 'ui-request')
    // `response` is missing the field its kind requires.
    harness.sendRaw({ type: 'ui-response', requestId: event.request.requestId, response: { kind: event.request.kind } })
  }
  await settle()

  // Dropping these would hang the agent loop outright, so the fallback applies
  // -- and it stays asymmetric: a renderer answering garbage is not
  // distinguishable from one that has gone away.
  assert.equal(await permission, false, 'permission denies')
  assert.equal(await enterPlan, true, 'entering plan mode still approves')
  harness.dispose()
})

test('a malformed ui-response is never answered with a fail', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'ui-response', requestId: 'nobody', response: { kind: 'permission' } })
  await settle()

  // There is no command id to fail against, and inventing one would reject a
  // request the client never made.
  assert.equal(harness.received.some((event) => event.type === 'fail'), false)
  harness.dispose()
})
