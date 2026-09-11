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
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'
import type { UserInput } from '../src/media/types.js'
import { assertNewImagesAllowed, TurnImageBlockError } from '../src/harness/turnImages.js'
import { imageErrorCopy } from '../src/media/imageErrors.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

type LoopRun = (
  input: UserInput,
  signal?: AbortSignal,
  messageId?: string,
  overrides?: unknown,
) => Promise<AgentRunResult>

interface Counters {
  invalidateCalls: number
  snapshots: number
  fileHistoryDisposals: number
}

interface Harness {
  controller: SessionController
  events: SessionEvent[]
  store: SessionStore
  session: SessionMeta
  proxy: ReturnType<typeof createRecordProxy>
  snapshotCalls: string[]
  trackedFiles: string[]
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
  /** The history cannot be read back, so the session runs without one. */
  fileHistoryInitFails?: boolean
  /** No title yet — the state a session is in until its first message. */
  untitled?: boolean
  /** The stub loop's image capability; defaults to capable. */
  imageCapable?: boolean
} = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-controller-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = options.untitled ? await store.create() : await store.create('controller test')

  const snapshotCalls: string[] = []
  const trackedFiles: string[] = []
  const events: SessionEvent[] = []
  const counters: Counters = { invalidateCalls: 0, snapshots: 0, fileHistoryDisposals: 0 }

  const loop = {
    run: options.run ?? (async () => okResult()),
    getActiveModel: () => ({
      model: 'test-model',
      modelKey: 'main',
      ...(options.imageCapable === false ? {} : { supportsImageInput: true }),
    }),
    // The real submission rule, so the pre-turn-start gate is exercised the
    // way production wires it — the loop owns the rule, the stub only mirrors.
    assertImagesAllowedForSubmission: (input: UserInput) =>
      assertNewImagesAllowed(input.images, options.imageCapable !== false, 'test-model'),
    invalidateRecordsCache: () => { counters.invalidateCalls += 1 },
  }

  const fileHistoryService = {
    init: async () => {
      if (options.fileHistoryInitFails) throw new Error('unreadable history')
    },
    dispose: () => { counters.fileHistoryDisposals += 1 },
    makeSnapshot: async (messageId: string) => { snapshotCalls.push(messageId) },
    trackEdit: async (filePath: string) => { trackedFiles.push(filePath) },
  } as unknown as FileHistoryService

  const proxy = createRecordProxy()
  const controller = new SessionController({
    cwd,
    store,
    session,
    existingRecords: [],
    recordProxy: proxy,
    getSession: () => ({ loop } as unknown as AgentSession),
    createFileHistoryService: () => fileHistoryService,
  })

  controller.onEvent((event) => events.push(event))
  controller.subscribe(() => { counters.snapshots += 1 })

  // init() is async; let it settle so the history is armed like in production.
  await Promise.resolve()
  await Promise.resolve()

  return { controller, store, session, proxy, events, snapshotCalls, trackedFiles, counters }
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

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(order, ['turn-start', 'loop.run', 'active-model', 'turn-end'])

  const start = harness.events[0]
  assert.equal(start?.type, 'turn-start')
  assert.equal(start.type === 'turn-start' ? start.displayInput : undefined, 'hello')
  // The same id threads through the snapshot, the loop run and any rollback.
  assert.equal(seenMessageId, start.type === 'turn-start' ? start.messageId : 'mismatch')
  assert.deepEqual(harness.snapshotCalls, [seenMessageId])

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

  await harness.controller.submit({ text: 'hello' })

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

test('a mid-turn image block reaches the notice with its exit; other failures keep their words', async () => {
  // S24: a fallback or plan route onto a text-only model fails inside the run,
  // where the notice is the only trace the user gets.
  const blocked = await createHarness({
    run: async () => {
      throw new TurnImageBlockError('model-not-capable', [], 'Model text-only does not accept image input.')
    },
  })
  await blocked.controller.submit({ text: 'look' })
  const notice = blocked.events.find((event) => event.type === 'notice')
  assert.equal(notice?.type === 'notice' ? notice.level : undefined, 'error')
  const content = notice?.type === 'notice' ? notice.content : ''
  assert.ok(content.startsWith('Model text-only does not accept image input.'), content)
  assert.ok(content.endsWith(imageErrorCopy('model-not-capable')!.action), content)

  // The previous test pins the other half: an ordinary provider failure — an
  // HTTP status, a bad endpoint — is reported word for word, never relabelled
  // as an image problem (design §13: 不谎称已避免).
})

test('submit hands the loop the full UserInput — text and image refs intact', async () => {
  const seen: UserInput[] = []
  const harness = await createHarness({
    run: async (input) => {
      seen.push(input)
      return okResult()
    },
  })

  const images = [
    makeImageAttachmentRef({ id: 'img-a', ownerSessionId: 's', name: 'first.png' }),
    makeImageAttachmentRef({ id: 'img-b', ownerSessionId: 's', name: 'second.png' }),
  ]
  await harness.controller.submit({ text: 'hello', images })

  assert.deepEqual(seen, [{ text: 'hello', images }])
})

test('a text-only model rejects an image-bearing submit before turn-start', async () => {
  const harness = await createHarness({ imageCapable: false })

  const images = [makeImageAttachmentRef({ id: 'img-x', ownerSessionId: 's', name: 'shot.png' })]
  await assert.rejects(
    harness.controller.submit({ text: 'look at this', images }),
    (error: unknown) =>
      error instanceof Error && /does not accept image input/.test(error.message),
  )

  // The turn never started: no turn-start, no snapshot, no records on disk.
  assert.equal(harness.events.filter((event) => event.type === 'turn-start').length, 0)
  assert.equal(harness.events.filter((event) => event.type === 'turn-end').length, 0)
  assert.equal(harness.snapshotCalls.length, 0)
  const stored = await harness.store.loadRecords(harness.session.id)
  assert.equal(stored.length, 0)
})

test('a rolled-back turn restores the input images with the text, in order', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        remainingTasks: [],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  const images = [
    makeImageAttachmentRef({ id: 'img-r1', ownerSessionId: 's', name: 'first.png' }),
    makeImageAttachmentRef({ id: 'img-r2', ownerSessionId: 's', name: 'second.png' }),
  ]
  await controller.submit({ text: 'rollback me', images })

  const restore = harness.events.find((event) => event.type === 'restore-input')
  assert.equal(restore?.type === 'restore-input' ? restore.text : undefined, 'rollback me')
  if (restore?.type !== 'restore-input') return
  assert.deepEqual(restore.images, images)

  // The rollback really removed the user message, so the refs exist only in
  // the restored draft — not as a leftover record.
  const remaining = await harness.store.loadRecords(harness.session.id)
  assert.equal(remaining.some((record) => record.type === 'message' && record.id !== undefined && record.role === 'user'), false)
})

test('a user cancel whose turn left only synthetic records rolls the prompt back', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input.text,
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input.text,
        remainingTasks: [],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  await controller.submit({ text: 'rollback me' })

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
        content: input.text,
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
        prompt: input.text,
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

  await controller.submit({ text: 'keep me' })

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

  await harness.controller.submit({ text: 'one' })
  await harness.controller.submit({ text: 'two' })

  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(300, 3))
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(200, 2))

  harness.controller.retarget({ ...harness.session, id: 'other-session' }, [])
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(0, 0))
  assert.equal(harness.controller.getSnapshot().usage.lastRequest, null)
  assert.equal(harness.controller.getSessionId(), 'other-session')
})

test('a request that lands mid-turn updates lastRequest before the turn ends', async () => {
  let harness: Harness | undefined
  const seenMidTurn: Array<{ inputTokens: number; outputTokens: number } | null> = []
  harness = await createHarness({
    run: async () => {
      // Two requests inside one turn, the way a tool step produces them.
      harness?.proxy.onRequestUsage(usage(1000, 1))
      seenMidTurn.push(harness?.controller.getSnapshot().usage.lastRequest ?? null)
      harness?.proxy.onRequestUsage(usage(2000, 2))
      seenMidTurn.push(harness?.controller.getSnapshot().usage.lastRequest ?? null)
      return okResult({ usage: usage(3000, 3), statusUsage: usage(2000, 2) })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(seenMidTurn, [usage(1000, 1), usage(2000, 2)])
  // The totals are the run's business alone — a mid-turn report must not add to
  // them, or every request would be counted twice.
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(3000, 3))
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(2000, 2))
})

test('a run that produced no response keeps the last request rather than falling back to an estimate', async () => {
  let harness: Harness | undefined
  harness = await createHarness({
    run: async () => {
      harness?.proxy.onRequestUsage(usage(1500, 4))
      return okResult({ usage: usage(0, 0) })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(1500, 4))
})

test('lastRequest is restored from the metrics sidecar for a session this process never ran', async () => {
  const harness = await createHarness()
  const resumed = await harness.store.create('resumed session')
  await harness.store.appendRecord(resumed.id, {
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: 'earlier',
    createdAt: new Date().toISOString(),
  })
  await harness.store.appendMetric(resumed.id, {
    event: 'turn',
    model: 'test-model',
    input_tokens: 19_000,
    response_tokens: 120,
    cache_read_tokens: 5_000,
    cache_hit_rate: null,
    tool_calls: 0,
    duration_ms: 10,
  })

  harness.controller.retarget(resumed, [])
  // The read is fire-and-forget — the switch does not wait on the disk.
  for (let attempt = 0; attempt < 50 && !harness.controller.getSnapshot().usage.lastRequest; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(
    harness.controller.getSnapshot().usage.lastRequest,
    { inputTokens: 19_000, cacheReadInputTokens: 5_000, outputTokens: 120 },
  )
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

test('the first user message names an untitled session, exactly as the store does', async () => {
  // The window chrome reads a session's name off the *pane* — the header, the
  // sidebar row — and nothing used to tell the pane what the store derived on
  // append. The name arrived only when something re-listed the store from disk,
  // which is a whole turn later.
  const harness = await createHarness({ untitled: true })
  const record: SessionRecord = {
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: 'x'.repeat(80),
    createdAt: new Date().toISOString(),
  }

  await harness.store.appendRecord(harness.session.id, record)
  harness.proxy.onRecord(record)

  const stored = (await harness.store.list()).find((meta) => meta.id === harness.session.id)
  assert.equal(harness.controller.getSessionMeta().title, stored?.title)
  assert.equal(harness.controller.getSessionMeta().title, 'x'.repeat(60), 'the store\'s own 60 characters')

  const announced = harness.events.filter((event) => event.type === 'session-meta')
  assert.equal(announced.length, 1)
  assert.equal(
    announced[0]?.type === 'session-meta' ? announced[0].session.id : undefined,
    harness.session.id,
    'the id never moves here; this is not a session switch',
  )

  // The second message is not a rename: only an unnamed session takes a name.
  harness.proxy.onRecord({ ...record, id: randomUUID(), content: '完全不同的第二条' })
  assert.equal(harness.controller.getSessionMeta().title, 'x'.repeat(60))
  assert.equal(harness.events.filter((event) => event.type === 'session-meta').length, 1)
})

test('a session that already has a title is never renamed by a message', async () => {
  const harness = await createHarness()

  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: '第一条消息',
    createdAt: new Date().toISOString(),
  })

  assert.equal(harness.controller.getSessionMeta().title, 'controller test')
  assert.deepEqual(harness.events.filter((event) => event.type === 'session-meta'), [])
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

test('a turn opens a snapshot before the loop runs', async () => {
  const order: string[] = []
  const harness = await createHarness({
    run: async () => {
      order.push('loop.run')
      return okResult()
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.equal(harness.snapshotCalls.length, 1)
  assert.deepEqual(order, ['loop.run'], 'the snapshot is awaited before the loop starts')
})

test('a turn runs normally when the file history never came up', async () => {
  const harness = await createHarness({ fileHistoryInitFails: true })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(harness.snapshotCalls, [], 'nothing is snapshotted onto state init would replace')
  assert.deepEqual(
    harness.events.filter((event) => event.type === 'notice'),
    [],
    'a session without history is a degraded session, not one worth interrupting',
  )
  assert.deepEqual(types(harness.events).slice(-1), ['turn-end'])
})

test('write tools reach the history of the session that is live now', async () => {
  const harness = await createHarness()

  await harness.controller.trackFileEdit('/tmp/a.ts')

  assert.deepEqual(harness.trackedFiles, ['/tmp/a.ts'])
})

test('dispose stops the file history so no backup outlives the session', async () => {
  const harness = await createHarness()

  harness.controller.dispose()

  assert.equal(harness.counters.fileHistoryDisposals, 1)
})

test('a second submit while a turn is in flight is rejected, not run', async () => {
  // The guard exists because everything after it assigns `this.abortController`:
  // a concurrent run would overwrite the live one and leave the first turn
  // impossible to interrupt. It throws rather than returning quietly, because a
  // dropped message is indistinguishable from one that was sent and answered with
  // nothing — a shell is supposed to catch this and queue the input instead
  // (`SessionHost.pumpQueue`, `App.tsx`'s `handleSubmit`).
  let release: (() => void) | undefined
  const runs: UserInput[] = []
  const harness = await createHarness({
    run: async (input) => {
      runs.push(input)
      // Only the first turn parks; later ones return straight away, or the
      // "accepts the next message" assertion below would wait forever.
      if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
      return okResult()
    },
  })

  const first = harness.controller.submit({ text: 'first' })
  await waitUntil(() => runs.length === 1, 'the first turn to start')

  await assert.rejects(
    () => harness.controller.submit({ text: 'second' }),
    /already running/,
    'the second submit must reject',
  )
  assert.deepEqual(runs, [{ text: 'first' }], 'and must not reach the loop')

  release?.()
  await first
  // The guard clears with the turn rather than latching: the same controller has
  // to accept the next message.
  assert.equal(harness.controller.getSnapshot().isStreaming, false)
  await harness.controller.submit({ text: 'third' })
  assert.deepEqual(runs, [{ text: 'first' }, { text: 'third' }])
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

  const first = harness.controller.submit({ text: 'first' })
  await waitUntil(() => seen.length === 1, 'the first turn to start')
  await assert.rejects(() => harness.controller.submit({ text: 'second' }), /already running/)

  harness.controller.interrupt('user-cancel')
  await first

  assert.equal(seen.length, 1, 'only one turn ever reached the loop')
  assert.equal(seen[0]?.aborted, true, 'and interrupting reached that turn')
})

test('a queued submission is accepted when its user record lands, not when the turn ends', async () => {
  const accepted: string[] = []
  const order: string[] = []
  const harness = await createHarness({
    run: async (_input, _signal, messageId, overrides) => {
      // What the real loop does: stamp the queued id on the user record and
      // append it, then keep working for the rest of the turn.
      const source = (overrides as { sourceQueuedMessageId?: string } | undefined)?.sourceQueuedMessageId
      order.push('user-record-appended')
      harness.proxy.onRecord({
        type: 'message',
        id: messageId ?? 'm1',
        role: 'user',
        content: 'queued',
        createdAt: new Date().toISOString(),
        ...(source ? { sourceQueuedMessageId: source } : {}),
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('turn-finished')
      return okResult()
    },
  })

  await harness.controller.submit({ text: 'queued' }, undefined, {
    queuedMessageId: 'q1',
    onAccepted: () => {
      accepted.push('q1')
      order.push('accepted')
    },
  })

  assert.deepEqual(accepted, ['q1'], 'exactly once')
  assert.deepEqual(order, ['user-record-appended', 'accepted', 'turn-finished'],
    'acceptance is the user record, not the end of the turn')

  const stamped = harness.events.find((event) =>
    event.type === 'record' && event.record.type === 'message' && event.record.sourceQueuedMessageId === 'q1')
  assert.ok(stamped, 'the user record carries the queued id a replay reads')
})

test('a submission refused before its user record is never accepted', async () => {
  let ran = false
  const harness = await createHarness({
    imageCapable: false,
    run: async () => { ran = true; return okResult() },
  })
  const accepted: string[] = []

  await assert.rejects(() => harness.controller.submit(
    { text: 'look', images: [makeImageAttachmentRef({ id: 'img-q', ownerSessionId: harness.session.id })] },
    undefined,
    { queuedMessageId: 'q1', onAccepted: () => accepted.push('q1') },
  ))

  assert.equal(ran, false, 'the gate runs before the loop')
  assert.deepEqual(accepted, [], 'so the queue keeps the message and its images')
})

/** Polls rather than sleeping, so the wait is as short as the work allows. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
