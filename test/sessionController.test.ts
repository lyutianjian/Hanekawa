import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SessionController, type SessionEvent } from '../src/runtime/sessionController.js'
import { createRecordProxy } from '../src/runtime/bridges.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type {
  AgentRunResult,
  SessionRecord,
  ToolProgressEvent,
} from '../src/harness/types.js'
import type { AgentSession } from '../src/runtime/types.js'
import type { CheckpointService } from '../src/services/checkpoint/checkpointService.js'

type LoopRun = (
  input: string,
  signal?: AbortSignal,
  messageId?: string,
  overrides?: unknown,
) => Promise<AgentRunResult>

interface Counters {
  invalidateCalls: number
  snapshots: number
  checkpointDisposals: number
}

interface Harness {
  controller: SessionController
  events: SessionEvent[]
  store: SessionStore
  session: SessionMeta
  proxy: ReturnType<typeof createRecordProxy>
  checkpointCalls: string[]
  counters: Counters
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, cacheReadInputTokens: 0, outputTokens }
}

function okResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { content: 'ok', usage: usage(10, 5), ...overrides }
}

async function createHarness(options: {
  run?: LoopRun
  checkpointInitFails?: boolean
  /** The service declines to snapshot this root; `init()` still resolves. */
  checkpointDisabledAtInit?: boolean
  /** The service trips its breaker on the first checkpoint. */
  checkpointDisablesOnFirstCall?: boolean
} = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-controller-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('controller test')

  const checkpointCalls: string[] = []
  const events: SessionEvent[] = []
  const counters: Counters = { invalidateCalls: 0, snapshots: 0, checkpointDisposals: 0 }

  const loop = {
    run: options.run ?? (async () => okResult()),
    getActiveModel: () => ({ model: 'test-model', modelKey: 'main' }),
    invalidateRecordsCache: () => { counters.invalidateCalls += 1 },
  }

  let checkpointEnabled = !options.checkpointDisabledAtInit
  const checkpointService = {
    init: async () => {
      if (options.checkpointInitFails) throw new Error('no git')
    },
    isEnabled: () => checkpointEnabled,
    dispose: () => { counters.checkpointDisposals += 1 },
    createCheckpoint: async (messageId: string) => {
      checkpointCalls.push(messageId)
      if (options.checkpointDisablesOnFirstCall) {
        checkpointEnabled = false
        return { success: false, disabled: true, error: 'Checkpoints disabled for this session: too big.' }
      }
      return { success: true, commitHash: `hash-${checkpointCalls.length}` }
    },
  } as unknown as CheckpointService

  const proxy = createRecordProxy()
  const controller = new SessionController({
    cwd,
    store,
    session,
    existingRecords: [],
    recordProxy: proxy,
    getSession: () => ({ loop } as unknown as AgentSession),
    createCheckpointService: () => checkpointService,
  })

  controller.onEvent((event) => events.push(event))
  controller.subscribe(() => { counters.snapshots += 1 })

  // init() is async; let it settle so checkpoints are armed like in production.
  await Promise.resolve()
  await Promise.resolve()

  return { controller, store, session, proxy, events, checkpointCalls, counters }
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function types(events: SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

test('a successful turn emits turn-start before the loop runs and turn-end after', async () => {
  const order: string[] = []
  let seenMessageId: string | undefined
  const harness = await createHarness({
    run: async (_input, _signal, messageId) => {
      order.push('loop.run')
      seenMessageId = messageId
      return okResult()
    },
  })
  harness.controller.onEvent((event) => order.push(event.type))

  await harness.controller.submit('hello')

  assert.deepEqual(order, ['turn-start', 'loop.run', 'active-model', 'turn-end'])

  const start = harness.events[0]
  assert.equal(start?.type, 'turn-start')
  assert.equal(start.type === 'turn-start' ? start.displayInput : undefined, 'hello')
  // The same id threads through the checkpoint, the loop run and any rollback.
  assert.equal(seenMessageId, start.type === 'turn-start' ? start.messageId : 'mismatch')
  assert.deepEqual(harness.checkpointCalls, [seenMessageId])

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  assert.equal(end.aborted, false)
  assert.equal(end.rolledBack, false)
  assert.deepEqual(end.usage, usage(10, 5))

  const snapshot = harness.controller.getSnapshot()
  assert.equal(snapshot.isStreaming, false)
  assert.deepEqual(snapshot.usage.total, usage(10, 5))
})

test('a failed turn reports the error but is not aborted, so the duration summary still renders', async () => {
  const harness = await createHarness({
    run: async () => { throw new Error('provider exploded') },
  })

  await harness.controller.submit('hello')

  const notice = harness.events.find((event) => event.type === 'notice')
  assert.equal(notice?.type, 'notice')
  if (notice?.type !== 'notice') return
  assert.equal(notice.level, 'error')
  assert.equal(notice.content, 'provider exploded')

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  // `aborted` mirrors the signal, not "did it throw" — this is what keeps the
  // "Worked for Xs" line on failed turns.
  assert.equal(end.aborted, false)
  assert.equal(end.usage, undefined)
})

test('a user cancel whose turn left only synthetic records rolls the prompt back', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input,
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input,
        remainingTasks: [],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  await controller.submit('rollback me')

  assert.deepEqual(
    types(harness.events),
    ['turn-start', 'transcript-reset', 'restore-input', 'active-model', 'turn-end'],
  )

  const reset = harness.events.find((event) => event.type === 'transcript-reset')
  assert.equal(reset?.type, 'transcript-reset')
  // Rolling back the current turn must not remount the transcript view.
  assert.equal(reset?.type === 'transcript-reset' ? reset.bumpGeneration : true, false)

  const restore = harness.events.find((event) => event.type === 'restore-input')
  assert.equal(restore?.type === 'restore-input' ? restore.text : undefined, 'rollback me')

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  assert.equal(end.aborted, true)
  assert.equal(end.rolledBack, true)
  assert.equal(harness.counters.invalidateCalls, 1)
})

test('a user cancel that produced real work reports the interruption instead of rolling back', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input,
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'tool_result',
        toolUseId: randomUUID(),
        tool: 'Bash',
        ok: true,
        content: 'done',
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input,
        remainingTasks: [
          { id: '1', status: 'pending', subject: 'a', description: 'a' },
          { id: '2', status: 'pending', subject: 'b', description: 'b' },
        ],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  await controller.submit('keep me')

  assert.deepEqual(types(harness.events), ['turn-start', 'notice', 'active-model', 'turn-end'])
  const notice = harness.events.find((event) => event.type === 'notice')
  assert.equal(notice?.type === 'notice' ? notice.level : undefined, 'system')
  assert.equal(notice?.type === 'notice' ? notice.content : undefined, 'Interrupted. 2 tasks remaining.')

  const end = harness.events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.aborted : undefined, true)
  assert.equal(end?.type === 'turn-end' ? end.rolledBack : undefined, false)
  assert.equal(harness.counters.invalidateCalls, 0)
})

test('token usage accumulates across turns and resets when the session is retargeted', async () => {
  let call = 0
  const harness = await createHarness({
    run: async () => {
      call += 1
      return okResult({ usage: usage(call * 100, call), statusUsage: usage(call * 100, call) })
    },
  })

  await harness.controller.submit('one')
  await harness.controller.submit('two')

  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(300, 3))
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(200, 2))

  harness.controller.retarget({ ...harness.session, id: 'other-session' }, [])
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(0, 0))
  assert.equal(harness.controller.getSnapshot().usage.lastRequest, null)
  assert.equal(harness.controller.getSessionId(), 'other-session')
})

test('tool progress drives the spinner text and only lists calls when several are in flight', async () => {
  const harness = await createHarness()

  const started = (id: string, name: string, input: unknown): ToolProgressEvent => ({
    call: { id, name, input },
    phase: 'started',
  })

  harness.proxy.onProgress(started('a', 'Read', { filePath: '/tmp/a' }))
  assert.equal(harness.controller.getSnapshot().spinnerSubText, 'Reading /tmp/a')
  let progress = harness.events.at(-1)
  assert.equal(progress?.type, 'tool-progress')
  assert.equal(progress?.type === 'tool-progress' ? progress.listContent : 'set', undefined)

  harness.proxy.onProgress(started('b', 'Read', { filePath: '/tmp/b' }))
  assert.equal(harness.controller.getSnapshot().spinnerSubText, 'Reading 2 files in parallel...')
  progress = harness.events.at(-1)
  assert.equal(
    progress?.type === 'tool-progress' ? progress.listContent : undefined,
    'Reading 2 files in parallel...',
  )

  harness.proxy.onProgress({ call: { id: 'a', name: 'Read', input: {} }, phase: 'finished' })
  harness.proxy.onProgress({ call: { id: 'b', name: 'Read', input: {} }, phase: 'finished' })
  assert.equal(harness.controller.getSnapshot().spinnerSubText, undefined)
})

test('subagent progress is tracked per agent and attached to the matching task record', async () => {
  const harness = await createHarness()

  harness.proxy.onProgress({
    call: { id: 'c1', name: 'Grep', input: { pattern: 'needle' } },
    phase: 'started',
    source: { type: 'subagent', agentType: 'explore', agentId: 'agent-1' },
  })
  const expected = 'explore > Grep: Searching for "needle"'
  assert.equal(harness.controller.getSubagentProgress().get('agent-1'), expected)
  assert.equal(harness.controller.getSnapshot().spinnerSubText, expected)

  const taskRecord: SessionRecord = {
    id: randomUUID(),
    type: 'subagent_task',
    agentId: 'agent-1',
    subagentType: 'explore',
    status: 'running',
    description: 'look',
    task: 'look around',
    createdAt: new Date().toISOString(),
  }
  harness.proxy.onRecord(taskRecord)

  const emitted = harness.events.at(-1)
  assert.equal(emitted?.type, 'record')
  assert.equal(emitted?.type === 'record' ? emitted.subagentProgress : undefined, expected)
})

test('an approval record carries the id of the tool_use it answers', async () => {
  const harness = await createHarness()
  const toolUseId = randomUUID()

  harness.proxy.onRecord({
    id: toolUseId,
    type: 'tool_use',
    tool: 'Bash',
    input: { command: 'ls' },
    riskLevel: 'confirm',
    createdAt: new Date().toISOString(),
  })
  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_approval',
    tool: 'Bash',
    input: { command: 'ls' },
    approved: true,
    riskLevel: 'confirm',
    createdAt: new Date().toISOString(),
  })

  const approval = harness.events.at(-1)
  assert.equal(approval?.type, 'record')
  assert.equal(approval?.type === 'record' ? approval.approvalToolUseId : undefined, toolUseId)
})

test('a task snapshot on a tool result becomes pull state', async () => {
  const harness = await createHarness()

  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_result',
    toolUseId: randomUUID(),
    tool: 'TaskUpdate',
    ok: true,
    content: 'ok',
    display: {
      summary: 'Updated tasks',
      taskSnapshot: { tasks: [], counts: { total: 0, remaining: 0, pending: 0, inProgress: 0, completed: 0 } },
    },
    createdAt: new Date().toISOString(),
  })

  assert.deepEqual(
    harness.controller.getSnapshot().taskSnapshot,
    { tasks: [], counts: { total: 0, remaining: 0, pending: 0, inProgress: 0, completed: 0 } },
  )
})

test('dispose unhooks the record proxy so nothing reaches a torn-down UI', async () => {
  const harness = await createHarness()
  const before = harness.events.length

  harness.controller.dispose()
  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_use',
    tool: 'Bash',
    input: {},
    riskLevel: 'safe',
    createdAt: new Date().toISOString(),
  })
  harness.proxy.onProgress({ call: { id: 'x', name: 'Bash', input: {} }, phase: 'started' })
  harness.proxy.onStreamEvent({ type: 'text_delta', text: 'hi' })

  assert.equal(harness.events.length, before)
})

test('checkpoints are skipped when the shadow repo fails to initialize', async () => {
  const harness = await createHarness({ checkpointInitFails: true })

  await harness.controller.submit('hello')

  assert.deepEqual(harness.checkpointCalls, [])
})

test('checkpoints are skipped when the service declines the root', async () => {
  // `init()` resolving is not consent: on an unsnapshottable root (the home
  // directory, a drive root) the service builds nothing and reports it through
  // `isEnabled()`. Arming on the resolve alone is what let every global-workspace
  // session run `git add --all` over the whole user profile.
  const harness = await createHarness({ checkpointDisabledAtInit: true })

  await harness.controller.submit('hello')

  assert.deepEqual(harness.checkpointCalls, [])
})

test('a tripped breaker stops later checkpoints and says so once', async () => {
  const harness = await createHarness({ checkpointDisablesOnFirstCall: true })

  await harness.controller.submit('first')
  await harness.controller.submit('second')

  assert.equal(harness.checkpointCalls.length, 1, 'the service is asked once, not once per turn')
  const notices = harness.events.filter(
    (event): event is Extract<SessionEvent, { type: 'notice' }> => event.type === 'notice',
  )
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.level, 'system')
  assert.match(notices[0]?.content ?? '', /Checkpoints disabled/)
})

test('dispose kills the checkpoint service so no git outlives the session', async () => {
  const harness = await createHarness()

  harness.controller.dispose()

  assert.equal(harness.counters.checkpointDisposals, 1)
})

test('a second submit while a turn is in flight is rejected, not run', async () => {
  // The guard exists because everything after it assigns `this.abortController`:
  // a concurrent run would overwrite the live one and leave the first turn
  // impossible to interrupt. It throws rather than returning quietly, because a
  // dropped message is indistinguishable from one that was sent and answered with
  // nothing — a shell is supposed to catch this and queue the input instead
  // (`SessionHost.pumpQueue`, `App.tsx`'s `handleSubmit`).
  let release: (() => void) | undefined
  const runs: string[] = []
  const harness = await createHarness({
    run: async (input) => {
      runs.push(input)
      // Only the first turn parks; later ones return straight away, or the
      // "accepts the next message" assertion below would wait forever.
      if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
      return okResult()
    },
  })

  const first = harness.controller.submit('first')
  await waitUntil(() => runs.length === 1, 'the first turn to start')

  await assert.rejects(
    () => harness.controller.submit('second'),
    /already running/,
    'the second submit must reject',
  )
  assert.deepEqual(runs, ['first'], 'and must not reach the loop')

  release?.()
  await first
  // The guard clears with the turn rather than latching: the same controller has
  // to accept the next message.
  assert.equal(harness.controller.getSnapshot().isStreaming, false)
  await harness.controller.submit('third')
  assert.deepEqual(runs, ['first', 'third'])
})

test('the first turn is still interruptible after a second submit was refused', async () => {
  // The point of the guard: the live AbortController must still be the first
  // turn's. If the refused submit had gone through, `interrupt()` would abort the
  // *second* turn's signal and the first would run on unstoppably.
  const seen: Array<AbortSignal | undefined> = []
  const harness = await createHarness({
    run: async (_input, signal) => {
      seen.push(signal)
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve())
      })
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    },
  })

  const first = harness.controller.submit('first')
  await waitUntil(() => seen.length === 1, 'the first turn to start')
  await assert.rejects(() => harness.controller.submit('second'), /already running/)

  harness.controller.interrupt('user-cancel')
  await first

  assert.equal(seen.length, 1, 'only one turn ever reached the loop')
  assert.equal(seen[0]?.aborted, true, 'and interrupting reached that turn')
})

/** Polls rather than sleeping, so the wait is as short as the work allows. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
