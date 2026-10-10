import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrap } from '../src/runtime/bootstrap.js'
import { SessionWorkspace } from '../src/runtime/sessionWorkspace.js'
import { SessionStore } from '../src/sessions/service.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { AnthropicProvider } from '../src/config/providers/anthropicProvider.js'
import { CoordinationService } from '../src/runtime/coordination/service.js'
import { CoordinationWakeEngine } from '../src/runtime/coordination/wakeEngine.js'
import { AUTO_WAKE_LIMIT } from '../src/runtime/coordination/wakeDecision.js'
import { createCoordinationTools } from '../src/tools/coordinationTools.js'
import type { SessionPane } from '../src/runtime/sessionWorkspace.js'
import type { CoordinationCaller } from '../src/runtime/protocol/coordinationHost.js'
import type { ModelRequest, ModelResponse, TurnOrigin } from '../src/harness/types.js'

const BACKGROUND = 'The user wants this project tidied up. This background is long enough to satisfy the eighty character minimum.'

/** One model request of a session's own turn, as the script sees it. */
interface ScriptCall {
  sessionId: string
  role: 'coordinator' | 'thread' | undefined
  request: ModelRequest
  /** Every message of the request, serialized; for `includes` checks. */
  text: string
  /** The newest user message of the request. */
  last: string
  /** The request carries the results of the model's own tool calls. */
  afterTool: boolean
}

type Script = (call: ScriptCall) => ModelResponse | Promise<ModelResponse>

const text = (content: string): ModelResponse => ({
  content,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
})

const tool = (name: string, input: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2)}`): ModelResponse => ({
  content: '',
  toolCalls: [{ id, name, input }],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
})

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

async function until(check: () => boolean | Promise<boolean>, what = 'the runtime did not settle'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(await check(), what)
}

function lastUserText(request: ModelRequest): string {
  // The new input since the model last spoke, without injected context; '' after a tool call.
  const messages = request.messages.filter((message) => !(message as { transient?: boolean }).transient)
  let start = messages.length
  while (start > 0 && messages[start - 1]!.role !== 'assistant') start--
  return JSON.stringify(messages.slice(start).filter((message) =>
    !(typeof message.content === 'string' && message.content.startsWith('<system-reminder>'))))
}

interface Lane {
  sessionId: string
  pane: SessionPane
  host: SessionHost
  client: SessionClient
  turns: Array<{ origin: TurnOrigin; ended: boolean }>
  close(): void
}

async function setup(t: TestContext, script: Script, options: { git?: boolean } = {}) {
  const testHome = await mkdtemp(path.join(tmpdir(), 'myagent-coord-home-'))
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-coord-project-'))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  if (options.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@example.com')
    await writeFile(path.join(cwd, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
  }

  const roles = new Map<string, 'coordinator' | 'thread' | undefined>()
  t.mock.method(AnthropicProvider.prototype, 'createMessage', async (request: ModelRequest) => {
    // Side requests (session title, tool-use summary) are not a turn's own.
    if (!request.cacheSource?.startsWith('agent:')) return text('Side')
    const sessionId = [...roles.keys()].find((id) => request.cacheSource.includes(id))
    assert.ok(sessionId, `request from an unknown session: ${request.cacheSource}`)
    return script({
      sessionId,
      role: roles.get(sessionId),
      request,
      text: JSON.stringify(request.messages),
      last: lastUserText(request),
      afterTool: lastUserText(request) === '[]',
    })
  })

  const lanes = new Map<string, Lane>()
  const opening = new Map<string, Promise<Lane>>()
  const opened: Array<{ sessionId: string; activate: boolean }> = []
  const notices: string[] = []
  const errors: unknown[] = []
  // Bound late: the service, the engine and the tools refer to one another.
  let service!: CoordinationService
  let workspace!: SessionWorkspace
  let project!: Awaited<ReturnType<typeof bootstrap>>

  const engine = new CoordinationWakeEngine({
    storeFor: (dir) => service.coordinationStore(dir),
    laneControl: (id) => lanes.get(id)?.host,
    openLane: async (dir, id, o) => (await openLane(dir, id, o)).host,
    notify: (n) => { notices.push(n.body) },
    onError: (error) => { errors.push(error) },
  })
  service = new CoordinationService({
    storeFor: () => project.store,
    laneControl: (id) => lanes.get(id)?.host,
    openLane: async (dir, id, o) => (await openLane(dir, id, o)).host,
    notify: (n) => { notices.push(n.body) },
    settings: () => ({}),
  }, engine)

  async function openLane(dir: string, sessionId: string, o: { activate: boolean }): Promise<Lane> {
    const live = lanes.get(sessionId)
    if (live) return live
    let pending = opening.get(sessionId)
    if (!pending) {
      opened.push({ sessionId, activate: o.activate })
      pending = createLane(dir, sessionId).finally(() => opening.delete(sessionId))
      opening.set(sessionId, pending)
    }
    return pending
  }

  async function createLane(dir: string, sessionId: string): Promise<Lane> {
    const meta = await project.store.resolve(sessionId)
    assert.ok(meta, `no session ${sessionId}`)
    roles.set(sessionId, meta.coordination?.role)
    const pane = await workspace.open(meta)
    const [server, remote] = createMemoryChannelPair()
    const host = new SessionHost({
      channel: server,
      project,
      scope: pane.scope,
      workspace,
      controller: pane.controller,
      runtimeSlot: pane.runtimeSlot,
      onPaneOpened: () => {},
      onPaneClosed: () => {},
    })
    const client = new SessionClient(remote)
    await client.hello()
    const turns: Lane['turns'] = []
    const offTurns = pane.controller.onEvent((event) => {
      if (event.type === 'turn-start') turns.push({ origin: event.origin ?? 'user', ended: false })
      else if (event.type === 'turn-end') { const last = turns.at(-1); if (last) last.ended = true }
    })
    const detach = engine.attachLane(dir, pane.controller, host)
    let closed = false
    const lane: Lane = {
      sessionId,
      pane,
      host,
      client,
      turns,
      close() {
        if (closed) return
        closed = true
        lanes.delete(sessionId)
        detach()
        offTurns()
        host.dispose()
        client.dispose()
        workspace.close(pane)
      },
    }
    lanes.set(sessionId, lane)
    return lane
  }

  const store = new SessionStore(cwd)
  await store.init()
  project = await bootstrap({
    cwd,
    store,
    session: store.createDraft(),
    confirmMcpTrust: async () => false,
    extraTools: createCoordinationTools(service),
  })
  workspace = new SessionWorkspace(project)
  project.config.setModelConfig('first', { provider: 'anthropic', model: 'first-model', apiKey: 'test-key' })
  await project.config.save()
  await project.reloadSettings()
  t.after(async () => {
    for (const lane of [...lanes.values()]) lane.close()
    await engine.idle(cwd)
    workspace.closeAll()
    await project.shutdown('test over')
  })

  const coordinatorId = await service.ensureCoordinator(cwd)
  const coordinator = await openLane(cwd, coordinatorId, { activate: true })
  const coordStore = service.coordinationStore(cwd)
  const caller: CoordinationCaller = { sessionId: coordinatorId, projectDir: cwd }

  const wakes = () => (lanes.get(coordinatorId)?.turns ?? []).filter((turn) => turn.origin === 'wake').length
  /** Waits until no lane is mid-turn, nothing is queued anywhere, and the engine has caught up. */
  const settle = async () => {
    let quietRounds = 0
    await until(async () => {
      await engine.idle(cwd)
      const busy = [...lanes.values()].some((lane) =>
        lane.host.state().streaming || lane.client.getQueuedMessages().length > 0) || opening.size > 0
      quietRounds = busy ? 0 : quietRounds + 1
      return quietRounds >= 5
    })
    assert.deepEqual(errors, [])
  }
  const thread = async (threadId: string) => {
    const record = (await coordStore.read()).threads.find((row) => row.threadId === threadId)
    assert.ok(record, `no thread ${threadId}`)
    return record
  }
  const start = (title: string, brief: string, writesCode = false) =>
    service.startThread(caller, { title, brief, background: BACKGROUND, writesCode })

  return { cwd, project, service, engine, coordStore, coordinatorId, coordinator, lanes, opened, caller, wakes, settle, thread, start, openLane, errors }
}

test('two StartThread calls (one in a worktree) converge into exactly one coordinator wake', async (t) => {
  const finishB = gate()
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') {
      if (call.last.includes('split this work')) {
        return {
          ...text(''),
          toolCalls: [
            { id: 'start-a', name: 'StartThread', input: { title: 'Code change', brief: 'BRIEF-A edit the code', background: BACKGROUND, writesCode: true } },
            { id: 'start-b', name: 'StartThread', input: { title: 'Research', brief: 'BRIEF-B read the docs', background: BACKGROUND, writesCode: false } },
          ],
        }
      }
      return text('Coordinator done.')
    }
    if (call.text.includes('BRIEF-B')) {
      await finishB.promise
      return text('B finished the research.')
    }
    return text('A finished the change.')
  }, { git: true })

  await h.coordinator.client.submit('split this work into two threads')
  const { threads } = await h.coordStore.read()
  assert.equal(threads.length, 2)
  const a = threads.find((row) => row.brief.includes('BRIEF-A'))!
  const b = threads.find((row) => row.brief.includes('BRIEF-B'))!
  assert.ok(a.worktree, 'the code-writing thread got a worktree')
  assert.ok(existsSync(a.worktree.cwd))
  assert.equal(b.worktree, undefined)
  assert.equal((await h.project.store.resolve(a.sessionId))?.coordination?.workingDir, a.worktree.cwd)
  assert.ok(h.opened.filter((o) => o.sessionId !== h.coordinatorId).every((o) => !o.activate), 'thread lanes never activate')

  // A done, B still running: no wake yet.
  await until(async () => (await h.thread(a.threadId)).status === 'idle')
  await h.engine.idle(h.cwd)
  assert.equal(h.wakes(), 0)

  finishB.open()
  await h.settle()
  assert.equal(h.wakes(), 1)
  const coordRecords = await h.project.store.loadRecords(h.coordinatorId)
  const wakeUser = coordRecords.filter((r) => r.type === 'message' && r.role === 'user').at(-1)
  assert.ok(wakeUser && wakeUser.type === 'message')
  assert.ok(wakeUser.content.includes('A finished the change.') && wakeUser.content.includes('B finished the research.'))
  assert.equal((await h.coordStore.read()).coordinator?.notes.length, 0)
})

test('AskCoordinator wakes the coordinator at once while another thread is still running', async (t) => {
  const finishSlow = gate()
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') return text('Answered.')
    if (call.text.includes('BRIEF-SLOW')) {
      await finishSlow.promise
      return text('Slow done.')
    }
    if (call.afterTool) return text('Waiting for an answer.')
    return tool('AskCoordinator', { question: 'Which database should I use?' })
  })
  const slow = await h.start('Slow', 'BRIEF-SLOW keep going')
  await h.start('Asker', 'BRIEF-ASK needs a decision')

  await until(() => h.wakes() === 1, 'the question did not wake the coordinator')
  assert.equal(h.lanes.get(slow.sessionId)!.host.state().streaming, true, 'the slow thread is still running')
  const records = await h.project.store.loadRecords(h.coordinatorId)
  assert.ok(records.some((r) => r.type === 'message' && r.role === 'user' && r.content.includes('Which database should I use?')))

  finishSlow.open()
  await h.settle()
})

test(`after ${AUTO_WAKE_LIMIT} automatic wakes the coordinator waits for the user`, async (t) => {
  let pingPong = true
  let threadId = ''
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') {
      if (call.afterTool || !pingPong || call.last.includes('stop now')) return text('Ok.')
      return tool('MessageThread', { threadId, text: 'Here is the answer, ask again.' })
    }
    if (call.afterTool) return text('Asked.')
    return tool('AskCoordinator', { question: 'Next question?' })
  })
  threadId = (await h.start('Chatty', 'BRIEF-CHATTY')).threadId
  await h.settle()
  assert.equal(h.wakes(), AUTO_WAKE_LIMIT)
  const state = (await h.coordStore.read()).coordinator!
  assert.equal(state.autoWakeCount, AUTO_WAKE_LIMIT)
  assert.equal(state.notes.length, 1, 'the last question waits in the inbox')

  pingPong = false
  await h.coordinator.client.submit('stop now and tell me')
  await h.settle()
  assert.equal(h.wakes(), AUTO_WAKE_LIMIT + 1, 'a user message resets the count and the waiting note wakes it')
  assert.equal((await h.coordStore.read()).coordinator!.autoWakeCount, 1)
})

test('a closed coordinator lane is cold-opened without activating and woken', async (t) => {
  const finish = gate()
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') return text('Seen.')
    await finish.promise
    return text('Thread done.')
  })
  const started = await h.start('Work', 'BRIEF-W')
  await until(() => h.lanes.get(started.sessionId)?.host.state().streaming === true)
  h.coordinator.close()
  await h.engine.idle(h.cwd)
  assert.equal(h.lanes.has(h.coordinatorId), false, 'nothing to deliver: the lane stays closed')

  finish.open()
  await h.settle()
  const reopen = h.opened.filter((o) => o.sessionId === h.coordinatorId)
  assert.deepEqual(reopen.map((o) => o.activate), [true, false])
  assert.equal(h.wakes(), 1)
})

test('MessageThread reaches idle, user-driven running, and unloaded threads', async (t) => {
  const userTurn = gate()
  let userTurnEntered!: () => void
  const entered = new Promise<void>((resolve) => { userTurnEntered = resolve })
  const userTurnRequests: string[] = []
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') return text('Noted.')
    if (call.text.includes('USER-LOOK') && !call.text.includes('RUNNING-MSG')) {
      userTurnRequests.push(call.text)
      if (userTurnRequests.length === 1) {
        userTurnEntered()
        await userTurn.promise
        return tool('Glob', { pattern: '*.none' })
      }
      return text('User turn done.')
    }
    return text(`Handled ${call.last.slice(0, 40)}`)
  })
  const started = await h.start('Target', 'BRIEF-T')
  await h.settle()
  const lane = () => h.lanes.get(started.sessionId)!

  // Idle: delivered as its own coordinator turn at once.
  await h.service.messageThread(h.caller, started.threadId, 'IDLE-MSG')
  await h.settle()
  assert.deepEqual(lane().turns.map((turn) => turn.origin), ['coordinator', 'coordinator'])
  const afterIdle = await h.project.store.loadRecords(started.sessionId)
  assert.ok(afterIdle.some((r) => r.type === 'message' && r.role === 'user' && r.content === 'IDLE-MSG'))

  // Running a user-driven turn: queued, never steered into that turn.
  const turn = lane().client.submit('USER-LOOK around')
  await entered
  await h.service.messageThread(h.caller, started.threadId, 'RUNNING-MSG')
  assert.equal(lane().client.getQueuedMessages().length, 1)
  userTurn.open()
  await turn
  await h.settle()
  assert.equal(userTurnRequests.length, 2)
  assert.ok(!userTurnRequests[1]!.includes('RUNNING-MSG'), 'the coordinator message did not join the user turn')
  assert.deepEqual(lane().turns.map((turn) => turn.origin), ['coordinator', 'coordinator', 'user', 'coordinator'])

  // Unloaded: cold-opened without activating, then delivered.
  lane().close()
  await h.service.messageThread(h.caller, started.threadId, 'COLD-MSG')
  await h.settle()
  assert.deepEqual(h.opened.filter((o) => o.sessionId === started.sessionId).map((o) => o.activate), [false, false])
  assert.deepEqual(lane().turns.map((turn) => turn.origin), ['coordinator'])
  const afterCold = await h.project.store.loadRecords(started.sessionId)
  assert.ok(afterCold.some((r) => r.type === 'message' && r.role === 'user' && r.content === 'COLD-MSG'))
})

test('StopThread discards messages queued before the stop', async (t) => {
  const hold = gate()
  let enteredThread!: () => void
  const entered = new Promise<void>((resolve) => { enteredThread = resolve })
  const threadTexts: string[] = []
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') return text('Ok.')
    threadTexts.push(call.text)
    if (threadTexts.length === 1) {
      enteredThread()
      await hold.promise
      return tool('Glob', { pattern: '*.none' })
    }
    return text('Thread reply.')
  })
  const started = await h.start('Stoppable', 'BRIEF-STOP')
  await entered
  await h.service.messageThread(h.caller, started.threadId, 'BEFORE-STOP')
  const lane = h.lanes.get(started.sessionId)!
  assert.equal(lane.client.getQueuedMessages().length, 1)

  await h.service.stopThread(h.caller, started.threadId)
  hold.open()
  await h.settle()
  assert.equal(lane.client.getQueuedMessages().length, 0)
  assert.ok(threadTexts.every((t) => !t.includes('BEFORE-STOP')), 'the discarded message was never sent')
  const records = await h.project.store.loadRecords(started.sessionId)
  assert.ok(!records.some((r) => r.type === 'message' && r.role === 'user' && r.content === 'BEFORE-STOP'))
  assert.equal((await h.thread(started.threadId)).status, 'interrupted')
  assert.equal(h.wakes(), 0, 'a stopped turn only queues its note')

  // A message after the stop goes through.
  await h.service.messageThread(h.caller, started.threadId, 'AFTER-STOP')
  await h.settle()
  assert.ok(threadTexts.some((t) => t.includes('AFTER-STOP')))
})

test('a thread turn the user drove only queues its note', async (t) => {
  const h = await setup(t, async (call) => {
    if (call.role === 'coordinator') return text('Ok.')
    return text(call.last.includes('USER-DIRECT') ? 'Did what the user said.' : 'Kickoff done.')
  })
  const started = await h.start('Direct', 'BRIEF-D')
  await h.settle()
  assert.equal(h.wakes(), 1, 'the kickoff report wakes the coordinator')

  await h.lanes.get(started.sessionId)!.client.submit('USER-DIRECT do this')
  await h.settle()
  assert.equal(h.wakes(), 1)
  const notes = (await h.coordStore.read()).coordinator!.notes
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.userDriven, true)
  assert.ok(notes[0]!.text.includes('Did what the user said.'))
  assert.equal((await h.coordStore.read()).coordinator!.autoWakeCount, 1, 'a user message in a thread does not reset the count')
})
