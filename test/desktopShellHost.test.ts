import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { SHELL_LANE, type ShellCommand, type SettingsChange, type WireLaneInfo } from '../src/desktop/shellProtocol.js'
import { createLaneMux } from '../src/runtime/protocol/laneChannel.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { shadowRepoPath } from '../src/services/checkpoint/checkpointService.js'
import {
  ProjectDirectory,
  type PaneLike,
  type ProjectEntry,
} from '../src/runtime/projectDirectory.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { Config, ModelConfig } from '../src/config/service.js'
import { mergeRouting, type Endpoint, type Routing } from '../src/config/routing.js'

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
  readonly deleted: string[] = []
  readonly renamed: Array<{ id: string; title: string }> = []
  /** Set to make `resolve` behave like the real prefix resolver. */
  resolvePrefixes = false

  constructor(private readonly log: string[] = []) {}

  async resolve(idOrPrefix: string): Promise<SessionMeta | undefined> {
    const exact = this.sessions.get(idOrPrefix)
    if (exact || !this.resolvePrefixes) return exact
    const matches = [...this.sessions.values()].filter((session) =>
      session.id.startsWith(idOrPrefix),
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  createDraft(title?: string): SessionMeta {
    const draft = sessionOf(`draft-${this.drafts.length + 1}`, title)
    this.drafts.push(draft)
    return draft
  }

  async list(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async delete(idOrPrefix: string): Promise<void> {
    this.deleted.push(idOrPrefix)
    this.log.push(`store-delete:${idOrPrefix}`)
    this.sessions.delete(idOrPrefix)
  }

  async rename(idOrPrefix: string, title: string): Promise<void> {
    this.renamed.push({ id: idOrPrefix, title })
    this.log.push(`store-rename:${idOrPrefix}`)
    const session = this.sessions.get(idOrPrefix)
    if (session) this.sessions.set(idOrPrefix, { ...session, title })
  }
}

/**
 * A config fake that records call order.
 *
 * The order matters more than the values here: `save()` landing *after*
 * `reloadSettings()` would be silently destroyed by the latter's
 * `config.load()`, so the log is what pins it.
 */
class FakeConfig {
  config: Config = { models: {}, agent: {} }
  saves = 0

  constructor(private readonly log: string[] = []) {}

  get(): Config {
    return this.config
  }

  getRouting(): Routing {
    return mergeRouting(this.config.routing)
  }

  setRouting(routing: Routing): void {
    this.config.routing = routing
  }

  setEndpoint(name: string, endpoint: Endpoint): void {
    this.config.endpoints = { ...this.config.endpoints, [name]: endpoint }
  }

  removeEndpoint(name: string): void {
    const referencing = Object.entries(this.config.models).find(([, model]) => model.endpoint === name)
    if (referencing) throw new Error(`Endpoint ${name} is used by model ${referencing[0]}`)
    const next = { ...this.config.endpoints }
    delete next[name]
    this.config.endpoints = next
  }

  setModelConfig(name: string, model: ModelConfig): void {
    this.config.models = { ...this.config.models, [name]: model }
  }

  removeModel(name: string): void {
    const routing = this.getRouting()
    const routed = [routing.main, routing.plan, routing.compact].includes(name)
    if (routed) throw new Error(`Model ${name} is still referenced by routing`)
    const next = { ...this.config.models }
    delete next[name]
    this.config.models = next
  }

  renameModel(oldKey: string, newKey: string): void {
    const model = this.config.models[oldKey]
    if (!model) throw new Error(`No model named ${oldKey}`)
    const next = { ...this.config.models }
    delete next[oldKey]
    next[newKey] = model
    this.config.models = next
    const routing = this.getRouting()
    for (const role of ['main', 'plan', 'compact'] as const) {
      if (routing[role] === oldKey) routing[role] = newKey
    }
    this.config.routing = routing
  }

  setDefaultModel(name: string): void {
    // Mirrors the real service: unresolvable keys are a silent no-op.
    if (!this.config.models[name]) return
    this.config.defaultModel = name
  }

  /**
   * Mirrors the real `ConfigService.resolveModel`, **including that it folds the
   * endpoint's `apiKey` and `baseUrl` into what it returns**.
   *
   * That fold is the whole reason `describeSettings` must project field by
   * field. A fake that skipped it would make the "no raw key on the wire" case
   * vacuous — it passed a deliberate `...resolveModel(key)` mutation until this
   * was fixed.
   */
  resolveModel(name: string): ModelConfig | undefined {
    const model = this.config.models[name]
    if (!model) return undefined
    if (!model.endpoint) return model.provider ? { ...model } : undefined
    const endpoint = this.config.endpoints?.[model.endpoint]
    if (!endpoint) return undefined
    const resolved: ModelConfig = {
      provider: endpoint.provider,
      ...(endpoint.baseUrl !== undefined ? { baseUrl: endpoint.baseUrl } : {}),
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...model,
    }
    return resolved.provider ? resolved : undefined
  }

  getSaveTarget(): string {
    return `${this.cwdLabel}/.myagent/config.json`
  }

  cwdLabel = 'project'

  async save(): Promise<void> {
    this.saves += 1
    this.log.push('config-save')
  }
}

class FakeProject implements ShellLaneProject {
  readonly store: FakeStore
  readonly config: FakeConfig
  readonly openedScopes: SessionMeta[] = []
  readonly shutdowns: string[] = []
  reloads = 0

  constructor(
    readonly cwd: string,
    private readonly log: string[],
  ) {
    this.store = new FakeStore(log)
    this.config = new FakeConfig(log)
    this.config.cwdLabel = cwd
  }

  async reloadSettings(): Promise<{ needsRuntimeRebuild: boolean }> {
    this.reloads += 1
    this.log.push(`reload-settings:${this.cwd}`)
    // The real one reports `hooksChanged` only — a provider edit reports false,
    // which is exactly why the shell does not consult it.
    return { needsRuntimeRebuild: false }
  }

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
  configRefreshes: Array<{ lane: string; rebuild: boolean; scope: string }>
  metaRefreshes: Array<{ lane: string; session: SessionMeta }>
  activates: string[]
  laneEvents: WireLaneInfo[][]
  allLanesClosed: string[]
  openProjectRequests: Array<string | undefined>
  /**
   * The interleaved action log the fakes append to (`close-pane:<id>`,
   * `store-delete:<id>`, `shutdown:<cwd>:<reason>`, `closeAll`). The only place
   * *relative order* between the workspace and the store is observable — two
   * separate arrays cannot tell "closed the lane first" from "closed it after".
   */
  log: string[]
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
  const configRefreshes: Array<{ lane: string; rebuild: boolean; scope: string }> = []
  const metaRefreshes: Array<{ lane: string; session: SessionMeta }> = []
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
      return {
        dispose: () => disposed.push(attach.lane),
        refreshAfterConfigChange: (options) => configRefreshes.push({ lane: attach.lane, ...options }),
        refreshSessionMeta: (session) => {
          metaRefreshes.push({ lane: attach.lane, session })
          // Mirrors production: the host hands the meta to its controller, and
          // `SessionPane.getSession()` reads back through it — which is what
          // makes the following `broadcastLanes()` carry the new title.
          attach.pane.session = session
        },
      }
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
    configRefreshes,
    metaRefreshes,
    activates,
    laneEvents,
    allLanesClosed,
    openProjectRequests,
    log,
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
  'list-sessions': { type: 'list-sessions', id: 'd' },
  'delete-session': { type: 'delete-session', id: 'e', projectRoot: 'r', sessionId: 's1' },
  'get-settings': { type: 'get-settings', id: 'f', projectRoot: 'r' },
  'settings-change': {
    type: 'settings-change',
    id: 'g',
    projectRoot: 'r',
    change: { scope: 'provider', kind: 'set-routing', role: 'main', value: 'inherit' },
  },
  'rename-session': { type: 'rename-session', id: 'h', projectRoot: 'r', sessionId: 's1', title: 'T' },
} as const satisfies Record<ShellCommand['type'], ShellCommand>

/**
 * One sample per `SettingsChange` variant. The keyed `satisfies` is the guard —
 * a variant added without a schema in `SETTINGS_CHANGE_SCHEMAS` fails by name,
 * and this array proves each one actually parses rather than merely typechecks.
 */
const SETTINGS_CHANGE_SAMPLES = {
  'set-endpoint': { scope: 'provider', kind: 'set-endpoint', name: 'e1', provider: 'anthropic' },
  'clear-endpoint-key': { scope: 'provider', kind: 'clear-endpoint-key', name: 'e1' },
  'remove-endpoint': { scope: 'provider', kind: 'remove-endpoint', name: 'e1' },
  'set-model': { scope: 'provider', kind: 'set-model', key: 'm1', model: 'claude-x' },
  'rename-model': { scope: 'provider', kind: 'rename-model', from: 'm1', to: 'm2' },
  'remove-model': { scope: 'provider', kind: 'remove-model', key: 'm1' },
  'set-default-model': { scope: 'provider', kind: 'set-default-model', key: 'm1' },
  'set-routing': { scope: 'provider', kind: 'set-routing', role: 'plan', value: 'm1' },
  'set-subagent-routing': { scope: 'provider', kind: 'set-subagent-routing', type: 'explore', value: 'm1' },
} as const satisfies Record<SettingsChange['kind'], SettingsChange>

test('every settings change variant round-trips through its schema', () => {
  for (const change of Object.values(SETTINGS_CHANGE_SAMPLES)) {
    const parsed = parseShellCommand({ type: 'settings-change', id: 'x', projectRoot: 'r', change })
    assert.equal(parsed.ok, true, `expected ${change.kind} to parse`)
    if (parsed.ok && parsed.command.type === 'settings-change') {
      assert.deepEqual(parsed.command.change, change)
    }
  }
})

test('a settings change with an unknown field is rejected', () => {
  const parsed = parseShellCommand({
    type: 'settings-change',
    id: 'x',
    projectRoot: 'r',
    change: { scope: 'provider', kind: 'remove-model', key: 'm1', sneaky: 1 },
  })
  assert.equal(parsed.ok, false, '.strict() must reject an extra field')
})

test('every shell command variant round-trips through its schema', () => {
  for (const command of Object.values(COMMAND_SAMPLES)) {
    const parsed = parseShellCommand(command)
    assert.equal(parsed.ok, true, `expected ${command.type} to parse`)
    if (parsed.ok) assert.deepEqual(parsed.command, command)
  }
  assert.deepEqual(
    Object.keys(COMMAND_SAMPLES).sort(),
    [
      'delete-session',
      'get-settings',
      'list-sessions',
      'open-project',
      'open-session',
      'panes',
      'rename-session',
      'settings-change',
    ],
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
    createOccupant: () => ({
      dispose: () => {},
      refreshAfterConfigChange: () => {},
      refreshSessionMeta: () => {},
    }),
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

// --- session history -------------------------------------------------------------

test('list-sessions reports every project, in open order, with sessions newest first', async () => {
  const h = createHarness()
  h.project.store.sessions.set('a-old', { ...sessionOf('a-old', 'Old'), updatedAt: '2026-08-01T00:00:00.000Z' })
  h.project.store.sessions.set('a-new', { ...sessionOf('a-new', 'New'), updatedAt: '2026-08-19T00:00:00.000Z' })
  const beta = h.addProject('C:\\repo\\beta')
  beta.project.store.sessions.set('b-1', sessionOf('b-1', 'In beta'))

  const result = await h.client.listSessions()

  assert.deepEqual(
    result.projects.map((project) => project.projectName),
    ['alpha', 'beta'],
  )
  assert.equal(result.projects[0]!.projectRoot, h.entry.root)
  assert.deepEqual(
    result.projects[0]!.sessions.map((session) => session.id),
    ['a-new', 'a-old'],
  )
  assert.deepEqual(result.projects[1]!.sessions.map((session) => session.id), ['b-1'])
})

test('list-sessions lists a project with no lane open — history is not the topology', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'Never opened'))

  const result = await h.client.listSessions()

  assert.deepEqual(await h.client.panes(), [], 'no lane exists')
  assert.equal(result.projects.length, 1)
  assert.equal(result.projects[0]!.sessions.length, 1)
})

// --- deleting sessions -----------------------------------------------------------

test('delete-session removes the files and the shadow repo of a closed session', async () => {
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Closed'))
    const repo = shadowRepoPath(cwd, 's1')
    await mkdir(repo, { recursive: true })

    const result = await h.client.deleteSession(project.entry.root, 's1')

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(project.project.store.deleted, ['s1'])
    assert.equal(existsSync(repo), false, 'the shadow repo went with the session')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session closes the open lane first, then deletes — no ghost row', async () => {
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Open'))
    const opened = await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()
    assert.equal(h.host.laneForSessionId('s1'), opened.lane)

    const result = await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(h.disposed, [opened.lane], 'the occupant was disposed')
    assert.equal(h.host.laneForSessionId('s1'), undefined)
    assert.deepEqual(await h.client.panes(), [], 'the row is gone, not stale')
    // The order, not just the outcome: a pane still bound to a session whose
    // JSONL just vanished recreates the file on its next append, so the close
    // has to land before the store is touched. Asserted on the shared log,
    // which is the only place the two fakes' relative order is visible.
    assert.deepEqual(
      h.log.filter((line) => line.startsWith('close-pane:') || line.startsWith('store-delete:')),
      ['close-pane:s1', 'store-delete:s1'],
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session deletes by the resolved id, not the prefix it was given', async () => {
  // `SessionStore.delete` accepts a prefix; `removeShadowRepo` does not. Passing
  // the raw wire string through would delete the right session and leave (or
  // worse, mis-target) the shadow repo.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.resolvePrefixes = true
    project.project.store.sessions.set('abcdef12-full-id', sessionOf('abcdef12-full-id', 'Prefixed'))
    const repo = shadowRepoPath(cwd, 'abcdef12-full-id')
    await mkdir(repo, { recursive: true })

    await h.client.deleteSession(project.entry.root, 'abcdef12')

    assert.deepEqual(project.project.store.deleted, ['abcdef12-full-id'])
    assert.equal(existsSync(repo), false)
    assert.equal(existsSync(shadowRepoPath(cwd, 'abcdef12')), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session rejects an unknown session and an unopened project', async () => {
  const h = createHarness()
  await assert.rejects(h.client.deleteSession(h.entry.root, 'nope'), /Session not found: nope/)
  await assert.rejects(
    h.client.deleteSession('C:\\repo\\never-opened', 's1'),
    /No project is open at/,
  )
})

test('deleting the session behind a project last lane still reaches the store', async () => {
  // The order trap: `detachLane` shuts the project down, after which
  // `directory.get()` no longer finds it. The store and cwd must have been
  // captured before that.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    const repo = shadowRepoPath(cwd, 's1')
    await mkdir(repo, { recursive: true })
    await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.deepEqual(project.project.shutdowns, ['session-deleted'], 'the project went down')
    assert.equal(h.directory.get(cwd), undefined, 'and left the directory')
    assert.deepEqual(project.project.store.deleted, ['s1'])
    assert.equal(existsSync(repo), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deleting a closed session leaves the topology untouched', async () => {
  // Why the renderer must refresh its history off the delete's own reply rather
  // than off a `lanes` event: no lane changed, and `ShellClient` swallows a
  // re-announcement of an identical list on purpose (identity stability). A
  // broadcast here would be dead weight that looked like a refresh signal.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1'))
    project.project.store.sessions.set('s2', sessionOf('s2'))
    await h.client.openSession({ sessionId: 's2', projectRoot: project.entry.root })
    await settle()
    const before = h.laneEvents.length
    const lanesBefore = h.client.getLanes()

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.equal(h.laneEvents.length, before, 'no listener was woken')
    assert.equal(h.client.getLanes(), lanesBefore, 'and the list kept its identity')
    assert.deepEqual(project.project.store.deleted, ['s1'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// --- settings ----------------------------------------------------------------

/** Seeds a config with one keyed endpoint and two models, one of them routed. */
function seedConfig(project: FakeProject): void {
  project.config.config = {
    endpoints: {
      main: { provider: 'anthropic', baseUrl: 'https://api.example', apiKey: 'sk-abcdefghijkl' },
    },
    models: {
      big: { model: 'claude-big', endpoint: 'main', contextWindow: 200_000 },
      small: { model: 'claude-small', endpoint: 'main' },
    },
    routing: { main: 'big' },
    defaultModel: 'big',
    agent: {},
  }
}

test('get-settings never lets a raw api key across the wire', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.getSettings(h.entry.root)

  // Asserted on the whole serialized reply rather than field by field: that is
  // the assertion that survives someone adding a spread of `resolveModel()`
  // later, which is the one bug here that leaks every key the user owns.
  assert.ok(
    !JSON.stringify(result).includes('sk-abcdefghijkl'),
    'the raw key must not appear anywhere in the reply',
  )
  assert.equal(result.settings.endpoints[0]?.apiKeyMasked, 'sk-a...ijkl')
  assert.equal(result.settings.endpoints[0]?.baseUrl, 'https://api.example')
})

test('get-settings projects models, routing and the save target', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const { settings, projects } = await h.client.getSettings(h.entry.root)

  assert.deepEqual(
    settings.models.map((model) => model.key),
    ['big', 'small'],
  )
  assert.equal(settings.models[0]?.contextWindow, 200_000)
  assert.equal(settings.routing.main, 'big')
  assert.equal(settings.routing.plan, 'inherit', 'an unset role reads as inherit')
  assert.deepEqual(
    settings.routing.subagent.map((row) => row.type),
    ['general', 'fork', 'explore', 'plan'],
    'the four built-ins always get a row',
  )
  assert.match(settings.saveTarget, /config\.json$/)
  assert.deepEqual(settings.providers, ['anthropic', 'openai'])
  assert.deepEqual(projects, [{ projectRoot: h.entry.root, projectName: 'alpha' }])
})

test('a configured model that cannot resolve is still listed, and says so', async () => {
  const h = createHarness()
  seedConfig(h.project)
  // A model pointing at an endpoint that does not exist — which is what
  // `resolveModel` returns undefined for. It must keep its row: a model that is
  // configured but unusable has to explain itself rather than vanish.
  h.project.config.config.models.broken = { model: 'gone', endpoint: 'missing' }

  const { settings } = await h.client.getSettings(h.entry.root)

  const broken = settings.models.find((model) => model.key === 'broken')
  assert.ok(broken, 'the unresolvable model is still drawn')
  assert.equal(broken?.resolves, false)
  assert.equal(settings.models.find((model) => model.key === 'big')?.resolves, true)
})

test('settings-change saves before reloading, or the reload would discard the edit', async () => {
  const h = createHarness()
  seedConfig(h.project)

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-routing',
    role: 'plan',
    value: 'small',
  })

  const saveAt = h.log.indexOf('config-save')
  const reloadAt = h.log.indexOf(`reload-settings:${h.project.cwd}`)
  assert.ok(saveAt >= 0 && reloadAt >= 0, 'both ran')
  assert.ok(
    saveAt < reloadAt,
    'save must precede reloadSettings: reloadSettings ends in config.load(), which re-reads ' +
      'the layers from disk and destroys an unsaved in-memory mutation',
  )
  assert.equal(h.project.config.config.routing?.plan, 'small', 'and the edit survived')
})

test('one edit reloads the project once and refreshes every lane of it', async () => {
  const h = createHarness()
  seedConfig(h.project)
  for (const id of ['s1', 's2', 's3']) h.project.store.sessions.set(id, sessionOf(id))
  for (const id of ['s1', 's2', 's3']) {
    await h.client.openSession({ sessionId: id, projectRoot: h.entry.root })
  }
  await settle()

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-routing',
    role: 'main',
    value: 'small',
  })

  assert.equal(h.project.reloads, 1, 'reloadSettings is per project, not per lane')
  assert.equal(h.configRefreshes.length, 3, 'every lane of the project rebuilt')
  assert.equal(result.rebuiltLanes, 3)
  assert.deepEqual(
    h.configRefreshes.map((refresh) => refresh.scope),
    ['routing', 'routing', 'routing'],
    'a routing edit re-resolves against routing, not models',
  )
  assert.ok(
    h.configRefreshes.every((refresh) => refresh.rebuild),
    'rebuild is unconditional - needsRuntimeRebuild is only hooksChanged',
  )
})

test('an edit in one project leaves another projects lanes alone', async () => {
  const h = createHarness()
  seedConfig(h.project)
  const other = h.addProject('C:\\repo\\beta')
  seedConfig(other.project)
  h.project.store.sessions.set('s1', sessionOf('s1'))
  other.project.store.sessions.set('s2', sessionOf('s2'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await h.client.openSession({ sessionId: 's2', projectRoot: other.entry.root })
  await settle()

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-default-model',
    key: 'small',
  })

  assert.equal(h.configRefreshes.length, 1)
  assert.equal(other.project.reloads, 0, 'the other project never reloaded')
})

test('a rejected reference check saves nothing', async () => {
  const h = createHarness()
  seedConfig(h.project)

  await assert.rejects(
    h.client.changeSettings(h.entry.root, {
      scope: 'provider',
      kind: 'remove-model',
      key: 'big',
    }),
    /still referenced by routing/,
  )
  assert.equal(h.project.config.saves, 0, 'the mutation threw before anything was written')
  assert.ok(h.project.config.config.models.big, 'and the model is untouched')
})

test('set-endpoint without an apiKey leaves the stored key alone', async () => {
  const h = createHarness()
  seedConfig(h.project)

  // What the form sends when the user edited the base URL but never touched the
  // key field, which is showing a mask.
  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-endpoint',
    name: 'main',
    provider: 'anthropic',
    baseUrl: 'https://api.changed',
  })

  assert.equal(h.project.config.config.endpoints?.main?.apiKey, 'sk-abcdefghijkl')
  assert.equal(h.project.config.config.endpoints?.main?.baseUrl, 'https://api.changed')
})

test('clear-endpoint-key is the only way a key is removed', async () => {
  const h = createHarness()
  seedConfig(h.project)

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'clear-endpoint-key',
    name: 'main',
  })

  assert.equal(h.project.config.config.endpoints?.main?.apiKey, undefined)
  assert.equal(h.project.config.config.endpoints?.main?.provider, 'anthropic', 'the rest survives')
})

test('set-default-model with an unresolvable key is a no-op, as the service defines it', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-default-model',
    key: 'nope',
  })

  assert.equal(result.settings.defaultModel, 'big', 'the default did not move')
})

test('rename-model carries the routing reference with it', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'rename-model',
    from: 'big',
    to: 'huge',
  })

  assert.equal(result.settings.routing.main, 'huge')
  assert.ok(result.settings.models.some((model) => model.key === 'huge'))
})

test('rename-session resolves a prefix and refreshes only that lane', async () => {
  const h = createHarness()
  h.project.store.resolvePrefixes = true
  h.project.store.sessions.set('abcdef1234', sessionOf('abcdef1234'))
  h.project.store.sessions.set('zzzz', sessionOf('zzzz'))
  await h.client.openSession({ sessionId: 'abcdef1234', projectRoot: h.entry.root })
  await h.client.openSession({ sessionId: 'zzzz', projectRoot: h.entry.root })
  await settle()

  const result = await h.client.renameSession(h.entry.root, 'abcdef', 'new title')
  await settle()

  assert.deepEqual(result, { ok: true, title: 'new title' })
  assert.deepEqual(
    h.project.store.renamed,
    [{ id: 'abcdef1234', title: 'new title' }],
    'the store is given the resolved id, never the prefix',
  )
  assert.equal(h.metaRefreshes.length, 1, 'only the renamed session lane heard about it')
  assert.equal(h.metaRefreshes[0]?.session.title, 'new title')
})

test('renaming a closed session succeeds and refreshes no occupant', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))

  const result = await h.client.renameSession(h.entry.root, 's1', 'renamed')
  await settle()

  assert.equal(result.ok, true)
  assert.equal(h.metaRefreshes.length, 0)
})

test('rename-session broadcasts, because sessionTitle is a lane field', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await settle()
  const before = h.laneEvents.length

  await h.client.renameSession(h.entry.root, 's1', 'renamed')
  await settle()

  assert.ok(
    h.laneEvents.length > before,
    'unlike delete-session this does change the topology the client compares',
  )
})

test('settings commands fail cleanly for a project that is not open', async () => {
  const h = createHarness()
  await assert.rejects(h.client.getSettings('C:\\repo\\never-opened'), /No project is open/)
  await assert.rejects(
    h.client.renameSession('C:\\repo\\never-opened', 's1', 'x'),
    /No project is open/,
  )
})
