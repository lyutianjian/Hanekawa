import { z } from 'zod/v3'
import { deleteSessionArtifacts } from '../runtime/deleteSession.js'
import type { SessionMeta } from '../sessions/service.js'
import type {
  DirectoryProject,
  DirectoryWorkspace,
  PaneLike,
  ProjectDirectory,
  ProjectEntry,
} from '../runtime/projectDirectory.js'
import { projectDisplayName } from '../runtime/projectDirectory.js'
import type { RuntimeChannel } from '../runtime/protocol/channel.js'
import type { LaneMux } from '../runtime/protocol/laneChannel.js'
import type { SessionPane, SessionWorkspace } from '../runtime/sessionWorkspace.js'
import type { RuntimeHost } from '../runtime/types.js'
import {
  SHELL_LANE,
  type ShellCommand,
  type ShellEvent,
  type WireLaneInfo,
  type WireShellDeleteSessionResult,
  type WireShellOpenProjectResult,
  type WireShellOpenSessionResult,
  type WireShellPanesResult,
  type WireSessionSummary,
  type WireShellSessionsResult,
} from './shellProtocol.js'

/**
 * The window's host: every decision a single-window shell makes about lanes
 * and projects, in a module a plain-node test can import.
 *
 * `main.ts` cannot be tested (`app.requestSingleInstanceLock()` runs at module
 * top level), so whatever lives only there is uncovered forever. This class is
 * where those decisions went: the lane registry, "one pane, one lane"
 * deduplication, the fixed detach order, "a project dies with its last lane",
 * and the pane-resolution choreography an `open-pane` used to do inline. What
 * deliberately stays in `main.ts`: the `BrowserWindow`, native dialogs, and
 * `bootstrap()` — the shell owns the MCP trust prompt and the error boxes, the
 * same split `ProjectDirectory` already draws.
 *
 * Two keys, and they are not interchangeable. The lane key is minted here and
 * never moves; `paneId` is the session id and travels under `/clear` and
 * `/resume`. Host callbacks arrive with the moving id, so they look lanes up
 * by scanning `pane.getSession()` — never by assuming the key.
 *
 * The occupant of a lane is opaque. Production passes a factory that builds a
 * `SessionHost` over the pane; a test passes a recorder. All this class needs
 * from either is `dispose()`, which is what keeps the shell protocol testable
 * without casting a `SessionHost`'s concrete deps.
 */

// --- the structural halves, generic for the same reason ProjectDirectory is --

/**
 * The project half the shell touches: a root, the store sessions resolve
 * through, the one scope-opener a fresh draft needs, and the one call that
 * stops background work.
 */
export interface ShellLaneProject extends DirectoryProject {
  readonly store: {
    resolve(idOrPrefix: string): Promise<SessionMeta | undefined>
    createDraft(title?: string): SessionMeta
    /** The sidebar's history: every session on disk, newest first. */
    list(): Promise<SessionMeta[]>
    delete(idOrPrefix: string): Promise<void>
  }
  /** The scope type is opaque here: the shell mints it and hands it straight to `adopt`. */
  openScope(session: SessionMeta): Promise<unknown>
}

/**
 * The workspace half: `SessionWorkspace`'s pane surface, declared structurally
 * so a test fakes it without casting. Parameterized by the pane type because
 * `createOccupant` needs the *real* pane (a `SessionHost` wants the
 * controller, the slot and the scope off it), and `PaneLike` alone would
 * erase those behind an assertion at the one place types matter most.
 */
export interface ShellLaneWorkspace<PaneT extends PaneLike = SessionPane> extends DirectoryWorkspace {
  paneForSession(sessionId: string): PaneT | undefined
  open(session: SessionMeta): Promise<PaneT>
  adopt(scope: unknown, options?: { modelKey?: string }): PaneT
  close(pane: PaneT): void
}

/** Everything a lane holds besides its key. The shell speaks to it only through `dispose()`. */
export interface LaneOccupant {
  dispose(): void
}

export interface LaneAttach<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  lane: string
  /** The mux view for this lane; the occupant speaks its protocol on it. */
  channel: RuntimeChannel
  pane: PaneT
  project: ProjectEntry<P, W>
}

/**
 * The default here is the structural slice, not `SessionWorkspace` itself: a
 * type-parameter default is checked against the constraint *before* `PaneT`
 * resolves, so `SessionWorkspace` — which only fits once `PaneT` is known to
 * be `SessionPane` — cannot be spelled as the default. The production shell
 * instantiates the triple explicitly:
 * `new ShellHost<RuntimeHost, SessionPane, SessionWorkspace>(…)`.
 */
export interface ShellHostDeps<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends ShellLaneWorkspace<PaneT> = ShellLaneWorkspace<PaneT>,
> {
  /** The mux both sides of the window share. `SHELL_LANE` is claimed here. */
  mux: LaneMux
  directory: ProjectDirectory<P, W>
  /** Mints lane keys. Monotonic and never reused — `/clear` and `/resume` must not move it. */
  nextLaneKey: () => string
  /** Builds a lane's occupant (production: the `SessionHost` for that pane). */
  createOccupant: (attach: LaneAttach<P, PaneT, W>) => LaneOccupant
  /** `open-project` hand-off. A shell that cannot open projects rejects the command. */
  onOpenProject?: (path?: string) => void
  /**
   * While quitting, `detachLane` skips project shutdown: teardown owns the
   * ordering then, and closing projects mid-loop would race its own sweep.
   */
  isQuitting?: () => boolean
  /** Fired when the last lane goes — the single window's "nothing left" moment. */
  onAllLanesClosed?: (reason: string) => void
}

interface LaneEntry<P extends DirectoryProject, W extends DirectoryWorkspace, PaneT extends PaneLike> {
  pane: PaneT
  project: ProjectEntry<P, W>
  occupant: LaneOccupant
}

// The defaults are the real halves; if either stops satisfying its structural
// slice, these constants stop compiling. `Satisfied` (not a boolean check) so a
// wrong member is a *type* error naming the gap, the same net
// `electronChannel.test.ts` casts over its Electron slices.
type Satisfied<Real, Ours> = Real extends Ours ? true : never
const runtimeHostSatisfiesShellLaneProject: Satisfied<RuntimeHost, ShellLaneProject> = true
const sessionWorkspaceSatisfiesShellLaneWorkspace: Satisfied<
  SessionWorkspace,
  ShellLaneWorkspace<SessionPane>
> = true

// --- inbound validation ------------------------------------------------------

const commandId = z.string()

const SHELL_COMMAND_SCHEMAS = {
  panes: z.object({ type: z.literal('panes'), id: commandId }).strict(),
  'open-session': z
    .object({
      type: z.literal('open-session'),
      id: commandId,
      sessionId: z.string().optional(),
      title: z.string().optional(),
      projectRoot: z.string().optional(),
    })
    .strict(),
  'open-project': z
    .object({ type: z.literal('open-project'), id: commandId, path: z.string().optional() })
    .strict(),
  'list-sessions': z.object({ type: z.literal('list-sessions'), id: commandId }).strict(),
  'delete-session': z
    .object({
      type: z.literal('delete-session'),
      id: commandId,
      projectRoot: z.string(),
      sessionId: z.string(),
    })
    .strict(),
} as const satisfies Record<ShellCommand['type'], z.ZodTypeAny>

type CommandOption = (typeof SHELL_COMMAND_SCHEMAS)[ShellCommand['type']]

export const shellCommandSchema = z.discriminatedUnion(
  'type',
  Object.values(SHELL_COMMAND_SCHEMAS) as unknown as [CommandOption, ...CommandOption[]],
)

type ParsedShellCommand = z.infer<typeof shellCommandSchema>

type Assert<T extends true> = T
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Field-level drift guard: a wrong type or a missing field reddens the build. */
type _NoDrift = Assert<MutuallyAssignable<ShellCommand, ParsedShellCommand>>

export interface ShellCommandParseFailure {
  ok: false
  /** Recovered when present, so the sender's promise rejects rather than hangs. */
  id?: string
  message: string
}

export type ShellCommandParseResult = { ok: true; command: ShellCommand } | ShellCommandParseFailure

/** Bounded because it is echoed back over the wire in a `fail`. */
const MAX_MESSAGE_CHARS = 500

export function parseShellCommand(message: unknown): ShellCommandParseResult {
  const parsed = shellCommandSchema.safeParse(message)
  if (parsed.success) {
    return { ok: true, command: parsed.data as ShellCommand }
  }
  const failure: ShellCommandParseFailure = { ok: false, message: describe(parsed.error) }
  if (isRecord(message) && typeof message.id === 'string') failure.id = message.id
  return failure
}

function describe(error: z.ZodError): string {
  const summary = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return summary.length > MAX_MESSAGE_CHARS ? `${summary.slice(0, MAX_MESSAGE_CHARS)}…` : summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// --- the host ----------------------------------------------------------------

export class ShellHost<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends ShellLaneWorkspace<PaneT> = ShellLaneWorkspace<PaneT>,
> {
  private readonly channel: RuntimeChannel
  /** Insertion-ordered: the lane list the renderer sees is the order lanes were opened. */
  private readonly lanes = new Map<string, LaneEntry<P, W, PaneT>>()

  constructor(private readonly deps: ShellHostDeps<P, PaneT, W>) {
    this.channel = deps.mux.lane(SHELL_LANE)
    this.channel.onMessage(this.handleMessage)
    // No `onClose`: a dead shell lane means the renderer is gone, and window
    // teardown — not this class — owns what happens then.
  }

  // --- lane lifecycle ------------------------------------------------------

  /**
   * Resolves or creates a pane, then attaches it to a lane.
   *
   * The same choreography `open-pane` used to do inline in `main.ts`: an
   * existing pane for the session is reused (one pane per session, or two
   * `AgentLoop`s append to one JSONL); a known session id resolves through the
   * store; anything else mints an in-memory draft. A pane that already has a
   * lane is not re-attached — the caller gets the existing key and an
   * activation request, which is the single-window equivalent of focusing.
   */
  async openLane(
    entry: ProjectEntry<P, W>,
    options: { sessionId?: string; title?: string } = {},
  ): Promise<WireShellOpenSessionResult> {
    if (options.sessionId !== undefined) {
      const existing = entry.workspace.paneForSession(options.sessionId)
      if (existing) return this.registerLane(entry, existing)
      const session = await entry.project.store.resolve(options.sessionId)
      if (!session) throw new Error(`Session not found: ${options.sessionId}`)
      return this.registerLane(entry, await entry.workspace.open(session))
    }
    const scope = await entry.project.openScope(entry.project.store.createDraft(options.title))
    return this.registerLane(entry, entry.workspace.adopt(scope, {}))
  }

  /**
   * The `onPaneOpened` hand-off: a `SessionHost` has already created the pane
   * in its workspace (an `open-pane` from some lane's renderer), and this
   * window needs the lane for it. Deduplicates on pane identity, so a second
   * arrival for the same pane is an activation, never a second occupant.
   */
  attachPane(entry: ProjectEntry<P, W>, pane: PaneT): string {
    return this.registerLane(entry, pane).lane
  }

  /**
   * The single exit path for every way a lane dies — a renderer's `close-pane`
   * arriving through `onPaneClosed`, the OS closing the window, a failed
   * `loadFile`, app teardown. Drops the map entry *first*, so re-entrant calls
   * find nothing and every path below runs at most once.
   *
   * Order is fixed and load-bearing: dispose the occupant (unsubscribe before
   * anything it could observe), close the lane (the control frame that
   * releases the renderer's pending requests — `SessionHost.dispose()` does
   * not touch the channel), then run the pane's own four-step close. After the
   * topology update, a project with no lanes left is shut down: `shutdown()`
   * is the only call that stops background tasks and MCP clients, and a
   * project nothing on screen can reach is a set of orphaned child processes.
   */
  detachLane(key: string, reason: string): void {
    const entry = this.lanes.get(key)
    if (!entry) return
    this.lanes.delete(key)
    entry.occupant.dispose()
    this.deps.mux.closeLane(key)
    entry.project.workspace.close(entry.pane)
    this.broadcastLanes()
    if (this.deps.isQuitting?.()) return
    const projectStillOpen = [...this.lanes.values()].some((held) => held.project === entry.project)
    if (!projectStillOpen) void this.deps.directory.closeProject(entry.project, reason)
    if (this.lanes.size === 0) this.deps.onAllLanesClosed?.(reason)
  }

  /**
   * `onPaneClosed` arrives with the pane's *current* session id — which moves
   * under `/clear` and `/resume`. The lane key does not, so the scan reads
   * through `pane.getSession()` exactly like the window map it replaced.
   */
  detachLaneBySessionId(paneId: string, reason: string): void {
    const lane = this.laneForSessionId(paneId)
    if (lane === undefined) return
    this.detachLane(lane, reason)
  }

  laneForSessionId(paneId: string): string | undefined {
    for (const [lane, entry] of this.lanes) {
      if (entry.pane.getSession().id === paneId) return lane
    }
    return undefined
  }

  laneKeys(): string[] {
    return [...this.lanes.keys()]
  }

  // --- topology ------------------------------------------------------------

  /**
   * The whole lane topology, across every project. The same projection every
   * `SessionHost`'s `describePanes` answers with, extended with the lane key —
   * so the renderer's tab bar and the hosts' pane lists can never disagree
   * about which panes exist.
   */
  describeLanes(): WireLaneInfo[] {
    const out: WireLaneInfo[] = []
    for (const [lane, entry] of this.lanes) out.push(this.describeOne(lane, entry))
    return out
  }

  /** Pushes the current topology on the shell lane. Fired on every change. */
  broadcastLanes(): void {
    this.post({ type: 'lanes', lanes: this.describeLanes() })
  }

  /**
   * Asks the renderer to make a lane active. Activation is a renderer concern
   * in a single window; all the main process can do is ask, and the renderer
   * is free to already be there.
   */
  requestActivate(lane: string): void {
    this.post({ type: 'activate', lane })
  }

  // --- commands ------------------------------------------------------------

  private handleMessage = (message: unknown): void => {
    const parsed = parseShellCommand(message)
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        this.post({ type: 'fail', id: parsed.id, message: parsed.message })
      }
      return
    }
    void this.runCommand(parsed.command)
  }

  private async runCommand(command: ShellCommand): Promise<void> {
    try {
      const result = await this.execute(command)
      this.post({ type: 'reply', id: command.id, result })
    } catch (error) {
      this.post({
        type: 'fail',
        id: command.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Exhaustive by `assertNever`: an unhandled variant must not compile. */
  private async execute(command: ShellCommand): Promise<unknown> {
    switch (command.type) {
      case 'panes':
        return { lanes: this.describeLanes() } satisfies WireShellPanesResult
      case 'open-session': {
        const entry =
          command.projectRoot !== undefined
            ? this.deps.directory.get(command.projectRoot)
            : this.deps.directory.entries()[0]
        if (!entry) throw new Error('No project is open.')
        return this.openLane(entry, { sessionId: command.sessionId, title: command.title })
      }
      case 'open-project': {
        // Missing callback rejects rather than answering `ok` — a focus that
        // silently did nothing is indistinguishable from success on the wire.
        if (!this.deps.onOpenProject) throw new Error('The shell cannot open projects.')
        this.deps.onOpenProject(command.path)
        return { ok: true } satisfies WireShellOpenProjectResult
      }
      case 'list-sessions':
        return this.listSessions()
      case 'delete-session':
        return this.deleteSession(command.projectRoot, command.sessionId)
      default:
        return assertNever(command)
    }
  }

  /**
   * Every project's session history, in the order projects were opened.
   *
   * `Promise.all` because the reads are independent and each one is a lock file,
   * a `readdir` and an index parse — bounded by open projects, so this saves tens
   * of milliseconds rather than seconds, but there is no reason to serialize it.
   * The sessions are projected field by field: this answers with *every* session
   * in *every* project, and `SessionMeta` carries two unbounded arrays
   * (`checkpoints`, `denialState`) that no row reads.
   */
  private async listSessions(): Promise<WireShellSessionsResult> {
    const projects = await Promise.all(
      this.deps.directory.entries().map(async (entry) => ({
        projectRoot: entry.root,
        projectName: projectDisplayName(entry.cwd),
        sessions: (await entry.project.store.list()).map(summarize),
      })),
    )
    return { projects } satisfies WireShellSessionsResult
  }

  /**
   * Deletes a session, lane and all. The order is fixed and every step of it is
   * load-bearing:
   *
   *  1. The entry's `store` and `cwd` are captured **before** anything closes.
   *     Deleting the session behind a project's last lane runs `closeProject`,
   *     after which `directory.get()` no longer finds it — reading them later
   *     would work until the day someone deletes their only open session.
   *  2. The id is **resolved** first. `SessionStore.delete` accepts a prefix but
   *     `removeShadowRepo` does not, so passing the raw wire string through
   *     would delete the right session and the wrong shadow repo (or throw on
   *     the guard). An id that resolves to nothing fails rather than silently
   *     answering `ok`.
   *  3. The lane goes before the files. `detachLane` is the single exit path,
   *     and a pane still holding a session whose JSONL just vanished is a ghost
   *     row whose next append recreates the file.
   *  4. `deleteSessionArtifacts` owns *what* gets deleted — store files, shadow
   *     repo, session memory, subagent transcripts. This method deliberately
   *     does not enumerate them: it did once, with two of the four, and the
   *     other two leaked.
   *
   * No topology broadcast at the end. Deleting an *open* session already
   * announced one from `detachLane`; deleting a closed one changes no lane, and
   * `ShellClient` swallows a re-announcement of an identical list by design. The
   * renderer refreshes its history off this command's own reply instead — which
   * is also the only signal that would work for a closed session.
   */
  private async deleteSession(
    projectRoot: string,
    sessionId: string,
  ): Promise<WireShellDeleteSessionResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) throw new Error(`No project is open at ${projectRoot}`)
    const { store } = entry.project
    const { cwd } = entry

    const session = await store.resolve(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const lane = this.laneForSessionId(session.id)
    if (lane !== undefined) this.detachLane(lane, 'session-deleted')

    await deleteSessionArtifacts(cwd, store, session.id)
    return { ok: true } satisfies WireShellDeleteSessionResult
  }

  // --- internals -----------------------------------------------------------

  private registerLane(entry: ProjectEntry<P, W>, pane: PaneT): WireShellOpenSessionResult {
    const existing = this.laneForPane(pane)
    if (existing !== undefined) {
      this.requestActivate(existing)
      return { lane: existing, pane: this.describeOne(existing, this.lanes.get(existing)!) }
    }
    const lane = this.deps.nextLaneKey()
    const occupant = this.deps.createOccupant({
      lane,
      channel: this.deps.mux.lane(lane),
      pane,
      project: entry,
    })
    this.lanes.set(lane, { pane, project: entry, occupant })
    // `lanes` before `activate`: one channel is FIFO, so the renderer always
    // builds its pane session for a lane before being asked to switch to it.
    this.broadcastLanes()
    this.requestActivate(lane)
    return { lane, pane: this.describeOne(lane, this.lanes.get(lane)!) }
  }

  private laneForPane(pane: PaneT): string | undefined {
    for (const [lane, entry] of this.lanes) {
      if (entry.pane === pane) return lane
    }
    return undefined
  }

  /**
   * Field by field through `ProjectDirectory.describe` — the one pane→wire
   * projection — with the lane key added. A live lane's project is open by
   * construction (`detachLane` shuts a project down only after its last lane
   * is gone), so a missing projection is an invariant break, not a row to
   * skip.
   */
  private describeOne(lane: string, entry: LaneEntry<P, W, PaneT>): WireLaneInfo {
    const [pane] = this.deps.directory.describe([entry.pane])
    if (!pane) throw new Error(`Lane ${lane} has no project to describe it.`)
    const info: WireLaneInfo = {
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      projectRoot: pane.projectRoot,
      projectName: pane.projectName,
      lane,
    }
    if (pane.sessionTitle !== undefined) info.sessionTitle = pane.sessionTitle
    return info
  }

  private post(event: ShellEvent): void {
    this.channel.post(event)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled shell command: ${JSON.stringify(value)}`)
}

/**
 * `SessionMeta` → the four fields a sidebar row reads. Field by field, never a
 * spread: `checkpoints` gains an entry per turn and `denialState` accumulates
 * streaks, and neither is read by anything downstream of this command.
 */
function summarize(session: SessionMeta): WireSessionSummary {
  const summary: WireSessionSummary = {
    id: session.id,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
  }
  if (session.title !== undefined) summary.title = session.title
  return summary
}

export {
  runtimeHostSatisfiesShellLaneProject,
  sessionWorkspaceSatisfiesShellLaneWorkspace,
}
