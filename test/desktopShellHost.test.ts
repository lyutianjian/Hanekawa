import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ShellHost,
  parseShellCommand,
  runtimeHostSatisfiesShellLaneProject,
  sessionWorkspaceSatisfiesShellLaneWorkspace,
  type LaneAttach,
  type ShellLaneProject,
  type ShellLaneWorkspace,
} from '../src/desktop/shellHost.js'
import { ShellClient } from '../src/desktop/renderer/shellClient.js'
import { SHELL_LANE, type ShellCommand, type WireLaneInfo } from '../src/desktop/shellProtocol.js'
import { createLaneMux } from '../src/runtime/protocol/laneChannel.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import {
  ProjectDirectory,
  type PaneLike,
  type ProjectEntry,
} from '../src/runtime/projectDirectory.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import type { SessionMeta } from '../src/sessions/service.js'

/**
 * `ShellHost` — every lane/project decision the single-window shell makes, with
 * a real `ProjectDirectory` over fake halves.
 *
 * The fakes follow the `ProjectDirectory` generic pattern: `implements` the
 * structural slices this class actually calls, so the constraints keep
 * checking them and the suite needs **no `as unknown as`** — a missing member
 * is a compile error, not a runtime surprise. The occupant is a recorder, the
 * pane is a mutable session holder (which is what makes the "`/clear` moves
 * the pane id, never the lane key" case writable), and the whole shell
 * protocol is driven through a memory pair with a mux on each side and the
 * shipping `ShellClient` on the renderer's `__shell` lane.
 *
 * The order assertions in the detach cases are the load-bearing ones: the map
 * entry drops before anything runs (re-entrancy), the occupant is disposed
 * before the pane closes, and a project's last lane is the only thing that
 * shuts the project down.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function sessionOf(id: string, title?: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    ...(title !== undefined ? { title } : {}),
  }
}

class FakePane implements PaneLike {
  constructor(public session: SessionMeta) {}
  getSession(): SessionMeta {
    return this.session
  }
}

/** The scope a fake project opens: exactly what `adopt` needs, nothing more. */
interface FakeScope {
  session: SessionMeta
}

class FakeStore {
  readonly sessions = new Map<string, SessionMeta>()
  readonly drafts: SessionMeta[] = []

  async resolve(idOrPrefix: string): Promise<SessionMeta | undefined> {
    return this.sessions.get(idOrPrefix)
  }

  createDraft(title?: string): SessionMeta {
    const draft = sessionOf(`draft-${this.drafts.length + 1}`, title)
    this.drafts.push(draft)
    return draft
  }
}

class FakeProject implements ShellLaneProject {
  readonly store = new FakeStore()
  readonly openedScopes: SessionMeta[] = []
  readonly shutdowns: string[] = []

  constructor(
    readonly cwd: string,
    private readonly log: string[],
  ) {}

  async openScope(session: SessionMeta): Promise<FakeScope> {
    this.openedScopes.push(session)
    return { session }
  }

  async shutdown(reason: string): Promise<void> {
    this.shutdowns.push(reason)
    this.log.push(`shutdown:${this.cwd}:${reason}`)
  }
}

class FakeWorkspace implements ShellLaneWorkspace<FakePane> {
  readonly panes: FakePane[] = []
  readonly closed: FakePane[] = []

  constructor(private readonly log: string[]) {}

  list(): readonly FakePane[] {
    return [...this.panes]
  }

  paneForSession(sessionId: string): FakePane | undefined {
    return this.panes.find((pane) => pane.getSession().id === sessionId)
  }

  async open(session: SessionMeta): Promise<FakePane> {
    const existing = this.paneForSession(session.id)
    if (existing) return existing
    const pane = new FakePane(session)
    this.panes.push(pane)
    return pane
  }

  adopt(scope: unknown, _options?: { modelKey?: string }): FakePane {
    // The one honest assertion in this file: `adopt`'s parameter is `unknown`
    // by design (the shell hands a scope straight through), and only the fake
    // knows what its own `openScope` produced.
    const { session } = scope as FakeScope
    const existing = this.paneForSession(session.id)
    if (existing) return existing
    const pane = new FakePane(session)
    this.panes.push(pane)
    return pane
  }

  close(pane: FakePane): void {
    const index = this.panes.indexOf(pane)
    if (index === -1) return
    this.panes.splice(index, 1)
    this.closed.push(pane)
    this.log.push(`close-pane:${pane.getSession().id}`)
  }

  closeAll(): void {
    for (const pane of [...this.panes]) this.close(pane)
    this.log.push(`closeAll`)
  }
}

interface Harness {
  host: ShellHost<FakeProject, FakePane, FakeWorkspace>
  client: ShellClient
  directory: ProjectDirectory<FakeProject, FakeWorkspace>
  entry: ProjectEntry<FakeProject, FakeWorkspace>
  project: FakeProject
  workspace: FakeWorkspace
  attaches: LaneAttach<FakeProject, FakePane, FakeWorkspace>[]
  disposed: string[]
  activates: string[]
  laneEvents: WireLaneInfo[][]
  allLanesClosed: string[]
  openProjectRequests: Array<string | undefined>
  /** The renderer-side mux: `lane(key)` observes a lane's death from that side. */
  rendererMux: ReturnType<typeof createLaneMux>
  setQuitting(value: boolean): void
  /** Registers another project in the same directory, with its own fakes. */
  addProject(cwd: string): { project: FakeProject; workspace: FakeWorkspace; entry: ProjectEntry<FakeProject, FakeWorkspace> }
}

function createHarness(options: { withOpenProject?: boolean } = {}): Harness {
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const mainMux = createLaneMux(mainTransport)
  const rendererMux = createLaneMux(rendererTransport)

  const directory = new ProjectDirectory<FakeProject, FakeWorkspace>()
  const log: string[] = []
  const first = createProject(directory, 'C:\\repo\\alpha', log)

  const attaches: LaneAttach<FakeProject, FakePane, FakeWorkspace>[] = []
  const disposed: string[] = []
  const activates: string[] = []
  const laneEvents: WireLaneInfo[][] = []
  const allLanesClosed: string[] = []
  const openProjectRequests: Array<string | undefined> = []
  let quitting = false
  let nextKey = 0

  const host = new ShellHost<FakeProject, FakePane, FakeWorkspace>({
    mux: mainMux,
    directory,
    nextLaneKey: () => `${++nextKey}`,
    createOccupant: (attach) => {
      attaches.push(attach)
      return { dispose: () => disposed.push(attach.lane) }
    },
    ...(options.withOpenProject === false
      ? {}
      : { onOpenProject: (path?: string) => openProjectRequests.push(path) }),
    isQuitting: () => quitting,
    onAllLanesClosed: (reason) => allLanesClosed.push(reason),
  })

  const shellLane = rendererMux.lane(SHELL_LANE)
  const client = new ShellClient(shellLane)
  client.onActivate((lane) => activates.push(lane))
  client.onLanes((lanes) => laneEvents.push([...lanes]))

  return {
    host,
    client,
    directory,
    entry: first.entry,
    project: first.project,
    workspace: first.workspace,
    attaches,
    disposed,
    activates,
    laneEvents,
    allLanesClosed,
    openProjectRequests,
    rendererMux,
    setQuitting: (value: boolean) => {
      quitting = value
    },
    addProject: (cwd: string) => createProject(directory, cwd, log),
  }
}

function createProject(
  directory: ProjectDirectory<FakeProject, FakeWorkspace>,
  cwd: string,
  log: string[],
) {
  const project = new FakeProject(cwd, log)
  const workspace = new FakeWorkspace(log)
  const entry = directory.add(project, workspace)
  return { project, workspace, entry }
}

/** Posts a raw command on the shell lane, bypassing `ShellClient`. */
function postRawShellCommand(lane: RuntimeChannel, command: unknown): void {
  lane.post(command)
}

// --- drift guards ------------------------------------------------------------

test('the structural shell halves are satisfied by the real runtime types', () => {
  // The compile-time assertions are the real test; this keeps the constants
  // used and the intent readable, the same net as electronChannel.test.ts.
  assert.ok(runtimeHostSatisfiesShellLaneProject)
  assert.ok(sessionWorkspaceSatisfiesShellLaneWorkspace)
})

const COMMAND_SAMPLES = {
  panes: { type: 'panes', id: 'a' },
  'open-session': { type: 'open-session', id: 'b', sessionId: 's1', title: 'T', projectRoot: 'r' },
  'open-project': { type: 'open-project', id: 'c', path: 'C:\\repo' },
} as const satisfies Record<ShellCommand['type'], ShellCommand>

test('every shell command variant round-trips through its schema', () => {
  for (const command of Object.values(COMMAND_SAMPLES)) {
    const parsed = parseShellCommand(command)
    assert.equal(parsed.ok, true, `expected ${command.type} to parse`)
    if (parsed.ok) assert.deepEqual(parsed.command, command)
  }
  assert.deepEqual(
    Object.keys(COMMAND_SAMPLES).sort(),
    ['open-project', 'open-session', 'panes'],
    'a variant added to ShellCommand must fail the satisfies table by name',
  )
})

test('a malformed command fails with the id recovered', () => {
  const parsed = parseShellCommand({ type: 'open-session', id: 'x1', bogus: true })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) {
    assert.equal(parsed.id, 'x1')
    assert.match(parsed.message, /bogus/)
  }
  assert.equal(parseShellCommand('nonsense').ok, false)
})

// --- open-session ------------------------------------------------------------

test('open-session without a sessionId mints a fresh draft and a lane', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  assert.equal(result.lane, '1')
  assert.equal(result.pane.lane, '1')
  assert.equal(result.pane.paneId, h.project.store.drafts[0]!.id)
  assert.equal(result.pane.projectRoot, h.entry.root)
  assert.equal(result.pane.projectName, 'alpha')

  // The full choreography: draft → scope → adopt → occupant on a lane channel.
  assert.equal(h.project.store.drafts.length, 1)
  assert.equal(h.project.openedScopes.length, 1)
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.attaches.length, 1)
  assert.equal(h.attaches[0]!.lane, '1')
  assert.equal(h.attaches[0]!.pane, h.workspace.panes[0])
  assert.equal(h.attaches[0]!.project, h.entry)
  assert.equal(typeof h.attaches[0]!.channel.post, 'function')

  // Topology and activation both reached the renderer, lanes before activate.
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1'])
  assert.deepEqual(h.activates, ['1'])
})

test('open-session defaults to the first open project', async () => {
  const h = createHarness()
  const result = await h.client.openSession()
  await settle()
  assert.equal(result.pane.projectRoot, h.entry.root)
})

test('open-session with no project open fails', async () => {
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const emptyDirectory = new ProjectDirectory<FakeProject, FakeWorkspace>()
  const host = new ShellHost<FakeProject, FakePane, FakeWorkspace>({
    mux: createLaneMux(mainTransport),
    directory: emptyDirectory,
    nextLaneKey: () => '1',
    createOccupant: () => ({ dispose: () => {} }),
  })
  void host
  const client = new ShellClient(createLaneMux(rendererTransport).lane(SHELL_LANE))
  await assert.rejects(client.openSession(), /No project is open/)
})

test('open-session reuses a session that already has a pane, and a pane that already has a lane', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'First'))

  const first = await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  const second = await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await settle()

  assert.equal(second.lane, first.lane)
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.attaches.length, 1, 'a lane that exists is activated, never rebuilt')
  assert.deepEqual(h.activates, [first.lane, first.lane])
})

test('open-session resolves a stored session id into a new pane and lane', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'Stored'))
  const result = await h.client.openSession({ sessionId: 's1' })
  await settle()

  assert.equal(result.pane.sessionTitle, 'Stored')
  assert.equal(h.project.store.drafts.length, 0, 'a known id must not mint a draft')
  assert.equal(h.project.openedScopes.length, 0)
  assert.equal(h.workspace.panes.length, 1)
})

test('open-session rejects an unknown session id', async () => {
  const h = createHarness()
  await assert.rejects(h.client.openSession({ sessionId: 'nope' }), /Session not found: nope/)
})

test('openLane attaches a pane the project already adopted, without a second one', async () => {
  // The bootstrap path: the initial scope was adopted before any lane existed,
  // and the first lane must claim *that* pane.
  const h = createHarness()
  const scope = await h.project.openScope(h.project.store.createDraft())
  const adopted = h.workspace.adopt(scope, {})

  const result = await h.host.openLane(h.entry, { sessionId: adopted.getSession().id })

  assert.equal(result.lane, '1')
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.project.store.drafts.length, 1)
  assert.equal(result.pane.paneId, adopted.getSession().id)
})

// --- attachPane (the onPaneOpened hand-off) -----------------------------------

test('attachPane dedups on pane identity and activates; a new pane gets a new lane', async () => {
  const h = createHarness()
  const first = await h.host.openLane(h.entry, {})

  // Same pane again: an activation, not a second occupant.
  assert.equal(h.host.attachPane(h.entry, h.workspace.panes[0]!), first.lane)
  assert.equal(h.attaches.length, 1)

  // A genuinely new pane (a host-side `open-pane` created it): a new lane.
  const scope = await h.project.openScope(h.project.store.createDraft('Second'))
  const pane = h.workspace.adopt(scope, {})
  const secondLane = h.host.attachPane(h.entry, pane)
  await settle()
  assert.equal(secondLane, '2')
  assert.equal(h.attaches.length, 2)
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1', '2'])
})

// --- panes ---------------------------------------------------------------------

test('panes reports the topology across projects, in open order', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })

  const beta = h.addProject('C:\\repo\\beta')
  beta.project.store.sessions.set('s2', sessionOf('s2', 'In beta'))
  await h.client.openSession({ sessionId: 's2', projectRoot: beta.entry.root })
  await settle()

  const lanes = await h.client.panes()
  assert.equal(lanes.length, 2)
  assert.equal(lanes[0]!.projectName, 'alpha')
  assert.equal(lanes[1]!.projectName, 'beta')
  assert.equal(lanes[0]!.lane, '1')
  assert.equal(lanes[1]!.lane, '2')
})

// --- open-project ---------------------------------------------------------------

test('open-project hands the path to the shell and answers ok', async () => {
  const h = createHarness()
  const result = await h.client.openProject('C:\\repo\\gamma')
  await settle()
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.openProjectRequests, ['C:\\repo\\gamma'])
})

test('open-project without a path still reaches the shell', async () => {
  const h = createHarness()
  await h.client.openProject()
  await settle()
  assert.deepEqual(h.openProjectRequests, [undefined])
})

test('open-project rejects when the shell cannot open projects', async () => {
  const h = createHarness({ withOpenProject: false })
  await assert.rejects(h.client.openProject('C:\\repo\\gamma'), /cannot open projects/)
})

// --- detach ---------------------------------------------------------------------

test('detachLane runs the fixed order and releases the renderer side', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  let rendererCloses = 0
  h.rendererMux.lane(result.lane).onClose(() => {
    rendererCloses += 1
  })

  const sessionId = h.workspace.panes[0]!.getSession().id
  h.host.detachLane(result.lane, 'lane-closed')
  await settle()

  // Occupant disposed, pane closed, lane closed on the renderer side too.
  assert.deepEqual(h.disposed, [result.lane])
  assert.deepEqual(h.workspace.closed.map((pane) => pane.getSession().id), [sessionId])
  assert.equal(rendererCloses, 1)

  // The project had no lanes left, so it was shut down — and the renderer saw
  // the topology update.
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
  assert.deepEqual(h.client.getLanes(), [])
  assert.deepEqual(h.allLanesClosed, ['lane-closed'])
})

test('detachLane is idempotent: a second call does nothing', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  h.host.detachLane(result.lane, 'lane-closed')
  h.host.detachLane(result.lane, 'lane-closed')
  await settle()

  assert.deepEqual(h.disposed, [result.lane])
  assert.equal(h.workspace.closed.length, 1)
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
})

test('detachLane skips project shutdown while quitting', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  h.setQuitting(true)
  h.host.detachLane(result.lane, 'app-quit')
  await settle()

  assert.deepEqual(h.project.shutdowns, [], 'teardown owns project shutdown while quitting')
  assert.deepEqual(h.allLanesClosed, [])
})

test('a project survives while another project loses its last lane', async () => {
  const h = createHarness()
  await h.client.openSession({ projectRoot: h.entry.root })

  const beta = h.addProject('C:\\repo\\beta')
  beta.project.store.sessions.set('s2', sessionOf('s2'))
  const betaLane = await h.client.openSession({ sessionId: 's2', projectRoot: beta.entry.root })
  await settle()

  h.host.detachLane(betaLane.lane, 'lane-closed')
  await settle()

  assert.deepEqual(beta.project.shutdowns, ['lane-closed'])
  assert.deepEqual(h.project.shutdowns, [])
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1'])
})

test('a project survives losing one lane while another of its lanes is open', async () => {
  const h = createHarness()
  const first = await h.client.openSession({ projectRoot: h.entry.root })
  const second = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()
  assert.notEqual(first.lane, second.lane)

  h.host.detachLane(first.lane, 'lane-closed')
  await settle()

  assert.deepEqual(h.project.shutdowns, [], 'one lane left: the project stays alive')
  assert.deepEqual(h.disposed, [first.lane])
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), [second.lane])
  assert.deepEqual(h.allLanesClosed, [])
})

test('detachLaneBySessionId follows a pane id that moved under /clear', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  // `/clear` retargets the controller: the same pane, a new session id. The
  // lane key is the one thing that did not move.
  const pane = h.workspace.panes[0]!
  pane.session = sessionOf('after-clear')
  h.host.broadcastLanes()
  await settle()

  assert.equal(h.host.laneForSessionId('after-clear'), result.lane)
  assert.equal(h.host.laneForSessionId(result.pane.paneId), undefined)
  assert.equal(h.client.getLanes()[0]!.paneId, 'after-clear')

  h.host.detachLaneBySessionId('after-clear', 'lane-closed')
  await settle()

  assert.deepEqual(h.disposed, [result.lane])
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
})

// --- wire-level failure path ------------------------------------------------------

test('a malformed command on the wire fails by id, not silently', async () => {
  const h = createHarness()
  const fails: Array<{ id: string; message: string }> = []
  h.rendererMux.lane(SHELL_LANE).onMessage((event) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'fail'
    ) {
      fails.push(event as { id: string; message: string })
    }
  })

  postRawShellCommand(h.rendererMux.lane(SHELL_LANE), {
    type: 'open-session',
    id: 'bad-1',
    bogus: true,
  })
  await settle()

  assert.equal(fails.length, 1)
  assert.equal(fails[0]!.id, 'bad-1')
  assert.match(fails[0]!.message, /bogus/)
})
