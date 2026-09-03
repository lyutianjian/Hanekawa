import { z } from 'zod/v3'
import path from 'node:path'
import { homedir } from 'node:os'
import { maskKey } from '../config/maskKey.js'
import { SUPPORTED_PROVIDER_NAMES } from '../config/providers/registry.js'
import type { Config, ModelConfig } from '../config/service.js'
import type { Endpoint, Routing } from '../config/routing.js'
import {
  loadLocalSettings,
  localSettingsPath,
  setLocalCacheTtl1h,
  setLocalThinking,
  setLocalPermissionEntries,
  setLocalStartupPermissionMode,
  setMcpServerTrustLocally,
  setSkillEnabledLocally,
  disabledSkillNames,
  type MyAgentSettings,
  type StartupPermissionMode,
} from '../config/settings.js'
import { DEFAULT_CONTEXT_MANAGEMENT, type ContextManagementConfig } from '../prompts/budget.js'
import { deleteSessionArtifacts } from '../runtime/deleteSession.js'
import type { ProviderConfigChangeScope } from '../runtime/providerRuntime.js'
import type { SessionMeta } from '../sessions/service.js'
import { SessionStore } from '../sessions/service.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import { BUILT_IN_AGENT_DEFINITIONS, type BaseAgentDefinition } from '../tools/agentTool.js'
import { SkillsService, type SkillDefinition } from '../services/skills/skillsService.js'
import { peekSessions } from './recentProjects.js'
import { getSkillsDir, isGlobalWorkspaceRoot } from '../utils/paths.js'
import type {
  DirectoryProject,
  DirectoryWorkspace,
  PaneLike,
  ProjectDirectory,
  ProjectEntry,
} from '../runtime/projectDirectory.js'
import { projectDisplayName, projectRootKey } from '../runtime/projectDirectory.js'
import type { RuntimeChannel } from '../runtime/protocol/channel.js'
import type { LaneMux } from '../runtime/protocol/laneChannel.js'
import type { SessionPane, SessionWorkspace } from '../runtime/sessionWorkspace.js'
import type { McpConnectionStatus, RuntimeHost } from '../runtime/types.js'
import {
  CONTEXT_MANAGEMENT_FIELDS,
  SHELL_LANE,
  type ShellCommand,
  type ShellEvent,
  type WireLaneInfo,
  type WireShellDeleteSessionResult,
  type WireShellOpenInEditorResult,
  type WireShellSetWindowThemeResult,
  type WireShellOpenProjectResult,
  type WireShellRemoveProjectResult,
  type WireShellOpenSessionResult,
  type WireShellPanesResult,
  type WireSessionSummary,
  type WireShellSessionsResult,
  type WireShellRenameSessionResult,
  type WireShellSettingsChangeResult,
  type WireShellSettingsResult,
  type WireSettingsSnapshot,
  type WireAgentDefinitionInfo,
  type WireContextManagementInfo,
  type WireEndpointInfo,
  type WireMcpServerInfo,
  type WireSkillInfo,
  type WireModelInfo,
  type WirePermissionGroup,
  type WirePermissionsInfo,
  type WireEditorTarget,
  type SettingsChange,
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
 * `SessionHost` over the pane; a test passes a recorder. All this class asks of
 * either is the three members of `LaneOccupant`, which is what keeps the shell
 * protocol testable without casting a `SessionHost`'s concrete deps.
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
    rename(idOrPrefix: string, title: string): Promise<void>
  }
  /**
   * The settings screen's read *and* write surface.
   *
   * A narrow structural slice rather than `ConfigService` itself, and every
   * member here exists on it with exactly this signature — `Satisfied<RuntimeHost,
   * ShellLaneProject>` below is what keeps that true. Do not add
   * `setFallbackModel` / `setCompactModel` / `removeRouting`: they do not exist,
   * which is why those two fields are read-only in the snapshot.
   *
   * The project is the right seam. There is one `ConfigService` per project and
   * up to N lanes over it, so reaching config through a lane's occupant would
   * mean picking an arbitrary one — and the settings screen can be pointed at a
   * project whose lanes you are not looking at. The occupant is only asked to
   * *react* (`refreshAfterConfigChange`).
   */
  readonly config: {
    get(): Config
    getRouting(): Routing
    setRouting(routing: Routing): void
    setEndpoint(name: string, endpoint: Endpoint): void
    removeEndpoint(name: string): void
    setModelConfig(name: string, model: ModelConfig): void
    removeModel(name: string): void
    renameModel(oldKey: string, newKey: string): void
    setDefaultModel(name: string): void
    setContextManagement(patch: Partial<ContextManagementConfig>): void
    resolveModel(name: string): ModelConfig | undefined
    getSaveTarget(): string
    save(): Promise<void>
  }
  /**
   * The merged settings the runtime is *running on*, for the cards that read
   * settings rather than config. Read here rather than re-merged off disk: a
   * second merge can differ from the loop's, and a screen showing rules the gate
   * is not enforcing is worse than a screen showing none.
   */
  getSettings(): MyAgentSettings
  /** Read-only: the agent cards list these; editing them means editing files. */
  listAgentDefinitions(): readonly BaseAgentDefinition[]
  reloadAgentDefinitions(): Promise<number>
  /** Re-reads `.myagent/skills/` and re-registers their slash commands. */
  reloadSkills(): Promise<number>
  /** As it stands now. Mutated in place by `reloadMcpServers`, never replaced. */
  readonly mcp: McpConnectionStatus
  reloadMcpServers(): Promise<void>
  /** Re-reads the settings layers. Per *project*, so the shell calls it once per edit. */
  reloadSettings(): Promise<{ needsRuntimeRebuild: boolean }>
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

/**
 * Everything a lane holds besides its key.
 *
 * Deliberately small, and every member required. Production passes a
 * `SessionHost`; a test passes a recorder — and because the interface is
 * structural, tsc names a member either of them forgets. The two beyond
 * `dispose()` were added together on purpose: both are "the shell needs to
 * speak to one lane's host", and widening this once for both was the whole
 * reason `rename-session` waited for the settings fan-out.
 */
export interface LaneOccupant {
  dispose(): void
  /**
   * This lane's project config changed.
   *
   * `rebuild` is the shell's decision, not something the host reads off
   * `reloadSettings()`. That call's `needsRuntimeRebuild` is *only*
   * `hooksChanged` (`bootstrap.ts:141`), so a provider or routing edit reports
   * `false` — trusting it would produce a settings screen that saves, redraws,
   * and does nothing until the next launch, which is indistinguishable from
   * working.
   */
  refreshAfterConfigChange(options: { rebuild: boolean; scope: ProviderConfigChangeScope }): void
  /**
   * The session's meta moved without the session moving — a rename. The host
   * refreshes its controller's copy and pushes `session-changed`; anything
   * heavier (`retarget`) would interrupt the turn and reset usage for a title.
   */
  refreshSessionMeta(session: SessionMeta): void
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
   * `open-in-editor` hand-off, given the project's real `cwd` — and, since T15,
   * one file inside it at one line (`target.path` already resolved to an
   * absolute path bounded by the cwd; absent means the directory itself).
   *
   * Awaited, unlike `onOpenProject`: launching an editor usually fails by not
   * being installed, and that has to come back as a `fail` the renderer can put
   * in the transcript. A shell without one rejects the command.
   */
  onOpenInEditor?: (cwd: string, target?: { path: string; line?: number }) => Promise<void>
  /**
   * Repaints the native title-bar overlay for the resolved theme (5g).
   *
   * Not awaited and allowed to be absent: see the `set-window-theme` arm of
   * `execute`.
   */
  onWindowTheme?: (theme: 'dark' | 'light') => void
  /**
   * While quitting, `detachLane` skips project shutdown: teardown owns the
   * ordering then, and closing projects mid-loop would race its own sweep.
   */
  isQuitting?: () => boolean
  /** Fired when the last lane goes — the single window's "nothing left" moment. */
  onAllLanesClosed?: (reason: string) => void
  /**
   * The persisted "added projects" registry, most recently opened first. The
   * sidebar's history lists every one of these — most without an open runtime —
   * beside the open projects and the global workspace.
   *
   * Optional so a test that only exercises open projects needs no fake; the
   * production shell always provides it.
   */
  knownProjects?: () => Promise<readonly string[]>
  /**
   * Opens a project on demand — a history row of a not-yet-open project was
   * clicked, or "new session" fired with nothing open at all. Bootstraps the
   * runtime and hands back the directory entry; when `sessionId` names the
   * session being opened, the bootstrap scope is built *over* it so the
   * project's first pane is the pane the click asked for.
   *
   * Optional for the same reason `knownProjects` is.
   */
  ensureProject?: (
    cwd: string,
    options?: { sessionId?: string },
  ) => Promise<ProjectEntry<P, W>>
  /**
   * Drops a project from the "added projects" registry — the write half of
   * `remove-project`. Optional for the same reason `knownProjects` is; a shell
   * without one still closes the lanes, it just cannot make the row stay gone.
   */
  onForgetProject?: (cwd: string) => Promise<void>
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

/**
 * The settings edits, keyed by `kind` for the same reason the commands are
 * keyed by `type`: a variant added to `SettingsChange` without a schema here
 * fails the build *by name*, and `_NoSettingsDrift` below catches a field that
 * drifted rather than a whole variant that went missing.
 */
const SETTINGS_CHANGE_SCHEMAS = {
  'set-endpoint': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-endpoint'),
      name: z.string(),
      provider: z.string(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .strict(),
  'clear-endpoint-key': z
    .object({ scope: z.literal('provider'), kind: z.literal('clear-endpoint-key'), name: z.string() })
    .strict(),
  'remove-endpoint': z
    .object({ scope: z.literal('provider'), kind: z.literal('remove-endpoint'), name: z.string() })
    .strict(),
  'set-model': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-model'),
      key: z.string(),
      model: z.string(),
      provider: z.string().optional(),
      endpoint: z.string().optional(),
      contextWindow: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .strict(),
  'rename-model': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('rename-model'),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
  'remove-model': z
    .object({ scope: z.literal('provider'), kind: z.literal('remove-model'), key: z.string() })
    .strict(),
  'set-default-model': z
    .object({ scope: z.literal('provider'), kind: z.literal('set-default-model'), key: z.string() })
    .strict(),
  'set-routing': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-routing'),
      role: z.union([z.literal('main'), z.literal('plan'), z.literal('compact')]),
      value: z.string(),
    })
    .strict(),
  'set-subagent-routing': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-subagent-routing'),
      type: z.string(),
      value: z.string(),
    })
    .strict(),
  'set-permission-entries': z
    .object({
      scope: z.literal('permissions'),
      kind: z.literal('set-permission-entries'),
      behavior: z.union([z.literal('allow'), z.literal('deny'), z.literal('ask')]),
      entries: z.array(z.string()),
    })
    .strict(),
  'set-startup-permission-mode': z
    .object({
      scope: z.literal('permissions'),
      kind: z.literal('set-startup-permission-mode'),
      mode: z.union([z.literal('default'), z.literal('acceptEdits'), z.literal('bypass')]),
    })
    .strict(),
  'reload-agent-definitions': z
    .object({ scope: z.literal('agent'), kind: z.literal('reload-agent-definitions') })
    .strict(),
  'set-cache-ttl': z
    .object({ scope: z.literal('general'), kind: z.literal('set-cache-ttl'), enabled: z.boolean() })
    .strict(),
  'set-thinking': z
    .object({ scope: z.literal('general'), kind: z.literal('set-thinking'), enabled: z.boolean() })
    .strict(),
  'set-context-management': z
    .object({
      scope: z.literal('general'),
      kind: z.literal('set-context-management'),
      // The same list the rows are drawn from, so a seventh field cannot reach
      // one and miss the other.
      field: z.enum(CONTEXT_MANAGEMENT_FIELDS),
      value: z.number(),
    })
    .strict(),
  'set-skill-enabled': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('set-skill-enabled'),
      name: z.string(),
      enabled: z.boolean(),
    })
    .strict(),
  'reload-skills': z
    .object({ scope: z.literal('extensions'), kind: z.literal('reload-skills') })
    .strict(),
  'set-mcp-trust': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('set-mcp-trust'),
      name: z.string(),
      trusted: z.boolean(),
    })
    .strict(),
  'reconnect-mcp': z
    .object({ scope: z.literal('extensions'), kind: z.literal('reconnect-mcp') })
    .strict(),
} as const satisfies Record<SettingsChange['kind'], z.ZodTypeAny>

type SettingsChangeOption = (typeof SETTINGS_CHANGE_SCHEMAS)[SettingsChange['kind']]

const settingsChangeSchema = z.discriminatedUnion(
  'kind',
  Object.values(SETTINGS_CHANGE_SCHEMAS) as unknown as [
    SettingsChangeOption,
    ...SettingsChangeOption[],
  ],
)

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
  'remove-project': z
    .object({ type: z.literal('remove-project'), id: commandId, projectRoot: z.string() })
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
  'get-settings': z
    .object({ type: z.literal('get-settings'), id: commandId, projectRoot: z.string().optional() })
    .strict(),
  'settings-change': z
    .object({
      type: z.literal('settings-change'),
      id: commandId,
      projectRoot: z.string(),
      change: settingsChangeSchema,
    })
    .strict(),
  'rename-session': z
    .object({
      type: z.literal('rename-session'),
      id: commandId,
      projectRoot: z.string(),
      sessionId: z.string(),
      title: z.string(),
    })
    .strict(),
  'open-in-editor': z
    .object({
      type: z.literal('open-in-editor'),
      id: commandId,
      projectRoot: z.string(),
      target: z
        .object({
          path: z.string().min(1),
          line: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'set-window-theme': z
    .object({
      type: z.literal('set-window-theme'),
      id: commandId,
      theme: z.enum(['dark', 'light']),
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
/** The same guard one level down, where the four settings cards will all land. */
type _NoSettingsDrift = Assert<MutuallyAssignable<SettingsChange, z.infer<typeof settingsChangeSchema>>>

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

/**
 * Bounds a renderer-named file to the project it was named under.
 *
 * Lexical, not `realpath`: the search tool that printed the path already kept
 * it inside the cwd, so this is a backstop against a renderer that names
 * something else — and a lexical check works in a test harness whose cwds do
 * not exist on disk. The prefix comparison needs no case folding because both
 * sides are built from the *same* `cwd` string; only the relative tail is the
 * renderer's.
 */
function resolveProjectFile(cwd: string, target: WireEditorTarget): { path: string; line?: number } {
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, target.path)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`Refusing to open "${target.path}": it is outside the project`)
  }
  return { path: absolute, ...(target.line === undefined ? {} : { line: target.line }) }
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
   *
   * `deferExit` hands that tail to the caller — the one caller that is about to
   * put a lane *back* (`deleteSession`). An explicit flag rather than a check on
   * `reason`: `reason` is a free string for logs and `shutdown()`, and making it
   * carry control flow turns every future reason into a semantic branch. **A
   * caller that defers owns what happens next**, including calling
   * `settleAfterLastLane` itself if it cannot replace the lane after all.
   */
  detachLane(key: string, reason: string, options: { deferExit?: boolean } = {}): void {
    const entry = this.lanes.get(key)
    if (!entry) return
    this.lanes.delete(key)
    entry.occupant.dispose()
    this.deps.mux.closeLane(key)
    entry.project.workspace.close(entry.pane)
    this.broadcastLanes()
    if (this.deps.isQuitting?.()) return
    if (options.deferExit) return
    this.settleAfterLastLane(entry.project, reason)
  }

  /**
   * What a detach means for the project and for the window: the last lane of a
   * project shuts it down, and the last lane of the window is the single-window
   * equivalent of "the last window closed".
   *
   * Split out of `detachLane` so a caller that defers it can run it later — or
   * not at all, when the lane has been replaced.
   */
  private settleAfterLastLane(project: ProjectEntry<P, W>, reason: string): void {
    const projectStillOpen = [...this.lanes.values()].some((held) => held.project === project)
    if (!projectStillOpen) void this.deps.directory.closeProject(project, reason)
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
   * The cwd of a *known but not open* project, by the wire's normalized root
   * key. `undefined` when the root names nothing the registry ever saw.
   */
  private async knownCwdForRoot(projectRoot: string): Promise<string | undefined> {
    if (!this.deps.knownProjects) return undefined
    const known = await this.deps.knownProjects()
    return known.find((cwd) => projectRootKey(cwd) === projectRoot)
  }

  /**
   * Which project an `open-session` lands on.
   *
   * Three cases, in order: a root that is already open; a root the registry
   * knows (bootstrapped on demand, over the session the command named, so the
   * bootstrap pane *is* the pane being asked for); and no root at all — the
   * first open project, else the global workspace, because "new session"
   * with nothing open is the global workspace's most ordinary entry.
   */
  private async resolveProjectEntry(
    projectRoot: string | undefined,
    sessionId: string | undefined,
  ): Promise<ProjectEntry<P, W>> {
    if (projectRoot !== undefined) {
      const open = this.deps.directory.get(projectRoot)
      if (open) return open
      // The home directory is deliberately *not* a registry member (it is the
      // implicit global workspace), so `knownCwdForRoot` can never answer for
      // it — and without this branch「不在项目中工作」would fail with "no project
      // is open" exactly when the workspace it names has never been opened.
      const cwd = (await this.knownCwdForRoot(projectRoot))
        ?? (projectRootKey(homedir()) === projectRoot ? homedir() : undefined)
      if (cwd !== undefined && this.deps.ensureProject) {
        return this.deps.ensureProject(cwd, sessionId !== undefined ? { sessionId } : {})
      }
      throw new Error(`No project is open at ${projectRoot}`)
    }
    const first = this.deps.directory.entries()[0]
    if (first) return first
    if (this.deps.ensureProject) return this.deps.ensureProject(homedir())
    throw new Error('No project is open.')
  }

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
        const entry = await this.resolveProjectEntry(command.projectRoot, command.sessionId)
        return this.openLane(entry, { sessionId: command.sessionId, title: command.title })
      }
      case 'open-project': {
        // Missing callback rejects rather than answering `ok` — a focus that
        // silently did nothing is indistinguishable from success on the wire.
        if (!this.deps.onOpenProject) throw new Error('The shell cannot open projects.')
        this.deps.onOpenProject(command.path)
        return { ok: true } satisfies WireShellOpenProjectResult
      }
      case 'remove-project':
        return this.removeProject(command.projectRoot)
      case 'list-sessions':
        return this.listSessions()
      case 'delete-session':
        return this.deleteSession(command.projectRoot, command.sessionId)
      case 'get-settings':
        return this.getSettings(command.projectRoot)
      case 'settings-change':
        return this.applySettingsChange(command.projectRoot, command.change)
      case 'rename-session':
        return this.renameSession(command.projectRoot, command.sessionId, command.title)
      case 'open-in-editor':
        return this.openInEditor(command.projectRoot, command.target)
      case 'set-window-theme': {
        // Unlike `open-project` / `open-in-editor`, a missing callback answers
        // `ok` rather than rejecting: the overlay is chrome, a shell without one
        // (every non-Windows build, and the test host) is not broken, and a
        // rejection here would put a native-chrome detail in the transcript.
        this.deps.onWindowTheme?.(command.theme)
        return { ok: true } satisfies WireShellSetWindowThemeResult
      }
      default:
        return assertNever(command)
    }
  }

  /**
   * Every *added* project's session history, in the order the registry keeps
   * (the order they were added, first added first), with the global workspace's
   * own sessions last — the sidebar's whole world, not just what is open right
   * now. The registry order is stable across opens, which is what keeps a group
   * from moving when one of its sessions is created; see `recentProjects.ts`.
   *
   * Two sources per root: an open project reads through its live store, a
   * registered-but-closed one through the read-only index peek (no runtime, no
   * lock). Open projects the registry somehow missed are appended defensively,
   * because a project on screen must be a project with history. `Promise.all`
   * because every read is independent — locks, `readdir`s and tiny JSON parses.
   *
   * The sessions are projected field by field: `SessionMeta` carries two
   * unbounded arrays (`checkpoints`, `denialState`) that no row reads.
   */
  private async listSessions(): Promise<WireShellSessionsResult> {
    const roots: string[] = []
    const addRoot = (cwd: string): void => {
      const key = projectRootKey(cwd)
      if (!roots.some((existing) => projectRootKey(existing) === key)) roots.push(cwd)
    }
    if (this.deps.knownProjects) {
      for (const cwd of await this.deps.knownProjects()) addRoot(cwd)
    }
    for (const entry of this.deps.directory.entries()) addRoot(entry.cwd)
    // The global workspace: always known, always listed, anchored last — a
    // project is where work belongs; the fallback is where it lands when
    // nothing is opened.
    addRoot(homedir())

    const projects = await Promise.all(
      roots.map(async (cwd) => {
        const entry = this.deps.directory.get(cwd)
        const sessions = entry ? await entry.project.store.list() : await peekSessions(cwd)
        return {
          cwd,
          open: entry !== undefined,
          projectRoot: projectRootKey(cwd),
          projectName: projectDisplayName(cwd),
          isGlobal: isGlobalWorkspaceRoot(cwd),
          sessions: sessions.map(summarize),
        }
      }),
    )
    return {
      // Carried even when the filter below drops the global group: the renderer
      // must be able to name the home workspace without matching its display
      // name, and「不在项目中工作」asks for it precisely when it has no row.
      globalRoot: projectRootKey(homedir()),
      projects: projects
        // Every *added* project is listed unconditionally, history or not: the
        // registry is what the sidebar draws a project row from, so a project
        // whose sessions were all deleted stays reachable and only
        // `remove-project` takes it off screen. The global workspace is the
        // exception — it is implicit rather than added, so it earns its row by
        // being open or by having sessions.
        .filter((project) => !project.isGlobal || project.open || project.sessions.length > 0)
        .map(({ cwd: _cwd, open: _open, ...project }) => project),
    } satisfies WireShellSessionsResult
  }

  /**
   * Forgets a project: its lanes go, its runtime shuts down, and the registry
   * entry is dropped. Nothing on disk is touched — the sessions are still there
   * if the directory is opened again.
   *
   * The lane teardown borrows `deleteSession`'s deferral (below): detaching the
   * window's *last* lane fires `onAllLanesClosed`, which quits the app off
   * darwin. "Remove this project from my sidebar" is not "I am done with this
   * window", so the last-lane case defers the exit and lands on a fresh global
   * workspace draft instead — the same answer `deleteSession` gives, and the
   * reason `deferExit` is a flag rather than a check on `reason`.
   */
  private async removeProject(projectRoot: string): Promise<WireShellRemoveProjectResult> {
    const entry = this.deps.directory.get(projectRoot)
    const cwd = entry?.cwd ?? (await this.knownCwdForRoot(projectRoot))
    if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
    // The global workspace is not a registry member, so there is nothing to
    // forget and nowhere for its sessions to go. Rejecting is the honest answer.
    if (isGlobalWorkspaceRoot(cwd)) throw new Error('The global workspace cannot be removed.')

    const lanes = [...this.lanes.entries()]
      .filter(([, held]) => held.project === entry)
      .map(([lane]) => lane)
    // True when this project holds every lane in the window: the exit has to be
    // deferred and a replacement lane opened, or the app quits under the user.
    const replacing = lanes.length > 0 && lanes.length === this.lanes.size
    for (const lane of lanes) this.detachLane(lane, 'project-removed', { deferExit: replacing })
    // The project itself still has to come down when its exit was deferred —
    // `deferExit` skips `settleAfterLastLane` entirely, and the replacement
    // below belongs to a *different* project.
    if (replacing && entry) void this.deps.directory.closeProject(entry, 'project-removed')

    await this.deps.onForgetProject?.(cwd)

    if (replacing) {
      try {
        if (!this.deps.ensureProject) throw new Error('The shell cannot open the global workspace.')
        await this.openLane(await this.deps.ensureProject(homedir()))
      } catch (error) {
        // The replacement is what the deferral was for. Without it the window
        // sits with zero lanes and the "nothing left" moment never fires, so
        // hand it over explicitly before reporting the failure.
        this.deps.onAllLanesClosed?.('project-removed')
        throw error
      }
    }
    return { ok: true } satisfies WireShellRemoveProjectResult
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
   *
   * The fifth step is conditional: deleting the session behind the window's
   * *only* lane used to run `onAllLanesClosed`, which quits the app off darwin —
   * "clean up this history" and "I am done with this window" were the same event
   * in `detachLane`. So that one case defers the tail and opens a draft instead:
   * an empty window is far closer to what was asked for, and a fresh draft is
   * what "new session" has always meant here. The draft is created **after**
   * `deleteSessionArtifacts`, so the sweep only ever faces the id being deleted.
   * A project's last lane in a *multi-project* window still shuts that project
   * down, exactly as closing its last pane does.
   */
  private async deleteSession(
    projectRoot: string,
    sessionId: string,
  ): Promise<WireShellDeleteSessionResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) {
      // A closed project's history is still deletable — through a transient
      // store, without bootstrapping a runtime for a deletion. No lane can
      // exist for a project the directory does not hold, so this is purely a
      // filesystem deletion.
      const cwd = await this.knownCwdForRoot(projectRoot)
      if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
      const store = new SessionStore(cwd)
      const session = await store.resolve(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      await deleteSessionArtifacts(cwd, store, session.id)
      return { ok: true } satisfies WireShellDeleteSessionResult
    }
    const { store } = entry.project
    const { cwd } = entry

    const session = await store.resolve(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const lane = this.laneForSessionId(session.id)
    // The window's last lane: the project must stay open, because the draft
    // below is going to be opened on it.
    const replacing = lane !== undefined && this.lanes.size === 1
    if (lane !== undefined) this.detachLane(lane, 'session-deleted', { deferExit: replacing })

    await deleteSessionArtifacts(cwd, store, session.id)

    if (replacing) {
      try {
        // No `sessionId`: a draft, and `registerLane` already broadcasts and
        // asks the renderer to activate it.
        await this.openLane(entry)
      } catch (error) {
        // The replacement is what the deferral was for. Without it the project
        // would sit in the directory with no lanes and no shutdown — orphaned
        // background tasks and MCP clients nothing on screen can reach.
        this.settleAfterLastLane(entry, 'session-deleted')
        throw error
      }
    }
    return { ok: true } satisfies WireShellDeleteSessionResult
  }

  // --- settings ------------------------------------------------------------

  /** The settings read model, plus the project list the screen's selector needs. */
  private async getSettings(projectRoot?: string): Promise<WireShellSettingsResult> {
    const entry =
      projectRoot !== undefined ? this.deps.directory.get(projectRoot) : this.deps.directory.entries()[0]
    if (!entry) throw new Error('No project is open.')
    return {
      settings: await this.describeSettings(entry),
      projects: this.deps.directory.entries().map((open) => ({
        projectRoot: open.root,
        projectName: projectDisplayName(open.cwd),
      })),
    } satisfies WireShellSettingsResult
  }

  /**
   * One settings edit. The order here is fixed and four steps of it are not
   * obvious:
   *
   *  - **`save()` before `reloadSettings()`.** `reloadSettings` ends in
   *    `config.load(settings)` (`bootstrap.ts`), which re-reads the config
   *    layers from disk. An in-memory mutation that has not been saved is
   *    *destroyed* by it. Swapping these two lines silently discards the user's
   *    edit while answering with a snapshot that looks right until the next pull.
   *  - **`save()` only when the config was mutated.** `save()` writes the whole
   *    merged `Config`, so calling it for a permissions or MCP edit would copy
   *    every settings-declared model and endpoint into `config.json` as a side
   *    effect of adding one rule.
   *  - **`reloadSettings()` once per project, not per lane.** It is a
   *    project-level call — N lanes over one project would re-read and
   *    re-validate the settings files N times for one edit.
   *  - **`afterReload` after it.** An MCP reconnect reads the settings the
   *    runtime now holds, so it has to run once the reload has replaced them.
   *
   * The fan-out is per variant rather than unconditional: permission rules and
   * the config layer are read live, and rebuilding a runtime for them would
   * throw away the prompt cache for nothing. `needsRuntimeRebuild` is still not
   * consulted — see `LaneOccupant.refreshAfterConfigChange`.
   */
  private async applySettingsChange(
    projectRoot: string,
    change: SettingsChange,
  ): Promise<WireShellSettingsChangeResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) throw new Error(`No project is open at ${projectRoot}`)

    // `ConfigService` owns the reference checks (a routed model, an endpoint a
    // model still points at, a rename onto an existing key, a context number
    // that cannot mean anything). Letting it throw keeps them in one place — and
    // nothing has been saved yet, so a rejection leaves the config as it was.
    const effect = await applySettingsEffect(entry, change)
    if (effect.saveConfig) await entry.project.config.save()
    await entry.project.reloadSettings()
    if (effect.afterReload) await effect.afterReload()

    let rebuiltLanes = 0
    if (effect.rebuild) {
      for (const held of this.lanes.values()) {
        if (held.project !== entry) continue
        held.occupant.refreshAfterConfigChange({ rebuild: true, scope: effect.scope })
        rebuiltLanes += 1
      }
    }
    return {
      settings: await this.describeSettings(entry),
      rebuiltLanes,
    } satisfies WireShellSettingsChangeResult
  }

  /**
   * Retitles a session, refreshing its lane if one is open.
   *
   * The id is resolved first for the same reason `delete-session` does it: the
   * store takes a prefix, but `laneForSessionId` compares whole ids.
   *
   * Unlike `delete-session` this *does* broadcast. `sessionTitle` is a
   * `WireLaneInfo` field and part of `ShellClient`'s list comparison, so the
   * topology genuinely differs and the swallow-identical-lists rule does not
   * apply.
   */
  private async renameSession(
    projectRoot: string,
    sessionId: string,
    title: string,
  ): Promise<WireShellRenameSessionResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) {
      // Same rule as delete: a transient store, no runtime. There is no lane to
      // refresh and no topology to broadcast — a closed session's title moves
      // only its index row.
      const cwd = await this.knownCwdForRoot(projectRoot)
      if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
      const store = new SessionStore(cwd)
      const session = await store.resolve(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      await store.rename(session.id, title)
      return { ok: true, title } satisfies WireShellRenameSessionResult
    }
    const { store } = entry.project

    const session = await store.resolve(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    await store.rename(session.id, title)

    const lane = this.laneForSessionId(session.id)
    if (lane !== undefined) {
      const updated = await store.resolve(session.id)
      if (updated) this.lanes.get(lane)?.occupant.refreshSessionMeta(updated)
    }
    this.broadcastLanes()
    return { ok: true, title } satisfies WireShellRenameSessionResult
  }

  /**
   * Hands the project's directory to an editor — or, with `target`, one file
   * inside it at one line (T15: a search result's path, clicked).
   *
   * `entry.cwd`, not `entry.root`: the root is the normalized comparison key
   * (`projectRootKey` lower-cases on Windows), and handing a case-folded path to
   * a process is a path that may not exist. The root is what the *renderer*
   * names, because it is the only project handle the lane list carries.
   */
  private async openInEditor(
    projectRoot: string,
    target?: WireEditorTarget,
  ): Promise<WireShellOpenInEditorResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) throw new Error(`No project is open at ${projectRoot}`)
    // Missing callback rejects rather than answering `ok`, the same rule
    // `open-project` follows: silence is indistinguishable from success.
    if (!this.deps.onOpenInEditor) throw new Error('The shell cannot open an editor.')
    await this.deps.onOpenInEditor(entry.cwd, target === undefined ? undefined : resolveProjectFile(entry.cwd, target))
    return { ok: true } satisfies WireShellOpenInEditorResult
  }

  /**
   * The settings snapshot, projected **field by field**.
   *
   * Never a spread, and never the return of `resolveModel()`: that method folds
   * the referenced endpoint's `apiKey` and `baseUrl` into what it hands back
   * (`config/service.ts`), so one spread ships every key the user owns across
   * the preload boundary. It is called here only for the `resolves` boolean.
   *
   * Async because the permission and MCP cards need the *local* settings layer
   * beside the merged one — the merge concatenates and unions, so it cannot say
   * which entries this screen is allowed to rewrite.
   */
  private async describeSettings(entry: ProjectEntry<P, W>): Promise<WireSettingsSnapshot> {
    const { config } = entry.project
    const raw = config.get()
    const routing = config.getRouting()
    const merged = entry.project.getSettings()
    const local = await loadLocalSettings(entry.cwd)

    const endpoints = Object.entries(raw.endpoints ?? {}).map(([name, endpoint]) => {
      const info: WireEndpointInfo = { name, provider: endpoint.provider }
      if (endpoint.baseUrl !== undefined) info.baseUrl = endpoint.baseUrl
      if (endpoint.apiKey) info.apiKeyMasked = maskKey(endpoint.apiKey)
      return info
    })

    const models = Object.entries(raw.models).map(([key, model]) => {
      const info: WireModelInfo = {
        key,
        model: model.model,
        resolves: config.resolveModel(key) !== undefined,
      }
      if (model.provider !== undefined) info.provider = model.provider
      if (model.endpoint !== undefined) info.endpoint = model.endpoint
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow
      if (model.maxOutputTokens !== undefined) info.maxOutputTokens = model.maxOutputTokens
      if (model.maxEffort !== undefined) info.maxEffort = model.maxEffort
      if (model.baseUrl !== undefined) info.baseUrl = model.baseUrl
      if (model.apiKey) info.apiKeyMasked = maskKey(model.apiKey)
      return info
    })

    // The four built-ins unioned with whatever routing already names, so a
    // custom `.myagent/agents/*.md` type that has been routed keeps its row.
    const subagentTypes = [...new Set([...BUILTIN_SUBAGENT_TYPES, ...Object.keys(routing.subagent ?? {})])]

    const permissions: WirePermissionsInfo = {
      localPath: localSettingsPath(entry.cwd),
      mode: startupMode(merged.permissions?.mode),
      modeIsLocal: local.permissions?.mode !== undefined,
      groups: (['allow', 'ask', 'deny'] as const).map((behavior) =>
        splitPermissionGroup(behavior, merged, local),
      ),
    }

    const builtInTypes = new Set(BUILT_IN_AGENT_DEFINITIONS.map((definition) => definition.type))
    const agents = entry.project.listAgentDefinitions().map((definition) => {
      const info: WireAgentDefinitionInfo = {
        type: definition.type,
        description: definition.description,
        builtIn: builtInTypes.has(definition.type),
        maxTurns: definition.maxTurns,
        isReadOnlyAgent: definition.isReadOnlyAgent,
        routing: routing.subagent?.[definition.type] ?? 'inherit',
      }
      if (definition.permissionMode !== undefined) info.permissionMode = definition.permissionMode
      if (definition.tools !== undefined) info.tools = [...definition.tools]
      if (definition.model !== undefined) info.model = definition.model
      return info
    })

    // Read off disk rather than through the runtime: `getSkills()` is already
    // filtered, and the card has to draw the switched-off ones too.
    const disabledSkills = disabledSkillNames(merged)
    const skills = (await new SkillsService(entry.cwd).listAll()).map((skill) =>
      describeSkill(skill, !disabledSkills.has(skill.name)),
    )

    const locallyTrusted = new Set(local.mcp?.trustedServers ?? [])
    const trusted = new Set(merged.mcp?.trustedServers ?? [])
    const mcpServers = Object.entries(merged.mcpServers ?? {}).map(([name, server]) =>
      describeMcpServer(name, server, entry.project.mcp, trusted, locallyTrusted),
    )

    // Merged over the defaults rather than reported as written: `config.json` may
    // name one field, and the screen has to show the number the budget will use.
    const contextValues = { ...DEFAULT_CONTEXT_MANAGEMENT, ...raw.agent.contextManagement }
    const contextManagement = Object.fromEntries(
      CONTEXT_MANAGEMENT_FIELDS.map((field) => [field, contextValues[field]]),
    ) as WireContextManagementInfo

    const snapshot: WireSettingsSnapshot = {
      projectRoot: entry.root,
      projectName: projectDisplayName(entry.cwd),
      saveTarget: config.getSaveTarget(),
      endpoints,
      models,
      routing: {
        main: routing.main ?? 'inherit',
        plan: routing.plan ?? 'inherit',
        compact: routing.compact ?? 'inherit',
        subagent: subagentTypes.map((type) => ({
          type,
          value: routing.subagent?.[type] ?? 'inherit',
        })),
      },
      providers: [...SUPPORTED_PROVIDER_NAMES],
      subagentTypes,
      permissions,
      agents,
      skills,
      skillsDir: getSkillsDir(entry.cwd),
      mcpServers,
      contextManagement,
      general: {
        localPath: localSettingsPath(entry.cwd),
        ...(merged.cache?.ttl1h !== undefined ? { cacheTtl1h: merged.cache.ttl1h } : {}),
        ...(merged.thinking !== undefined ? { thinking: merged.thinking } : {}),
      },
    }
    if (raw.defaultModel !== undefined) snapshot.defaultModel = raw.defaultModel
    if (raw.fallbackModel !== undefined) snapshot.fallbackModel = raw.fallbackModel
    if (raw.compactModel !== undefined) snapshot.compactModel = raw.compactModel
    return snapshot
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
 * A session index row → the four fields a sidebar row reads. Field by field,
 * never a spread: `SessionMeta` gains entries (`checkpoints` per turn,
 * `denialState` streaks) that nothing downstream of this command reads, and the
 * registry peek's narrower rows satisfy the same shape.
 */
function summarize(session: {
  id: string
  updatedAt: string
  messageCount: number
  title?: string
}): WireSessionSummary {
  const summary: WireSessionSummary = {
    id: session.id,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
  }
  if (session.title !== undefined) summary.title = session.title
  return summary
}

/**
 * The subagent types that always get a routing row, whether or not the config
 * has spoken about them. Mirrors the built-ins `.myagent/agents/` may override.
 */
const BUILTIN_SUBAGENT_TYPES = ['general', 'fork', 'explore', 'plan'] as const

/**
 * The startup mode the screen is able to write back.
 *
 * `StartupPermissionMode` is `Exclude<PermissionMode, 'plan'>`, so its type also
 * admits `readonly` — but `validateSettings` accepts only these three, meaning a
 * file naming `readonly` never loads at all. Reporting the default instead keeps
 * the select from offering a value that would make the next reload throw.
 */
function startupMode(mode: StartupPermissionMode | undefined): WirePermissionsInfo['mode'] {
  return mode === 'acceptEdits' || mode === 'bypass' ? mode : 'default'
}

/**
 * One permission group, split into "in the local layer" and "from somewhere
 * else".
 *
 * Subtracted by *count*, not as a set: a literal that appears in both the
 * project and the local layer really is in the merge twice, and exactly one of
 * those copies is the one this screen can remove. Treating them as sets would
 * report the entry as purely inherited and then quietly delete it anyway.
 */
function splitPermissionGroup(
  behavior: 'allow' | 'deny' | 'ask',
  merged: MyAgentSettings,
  local: MyAgentSettings,
): WirePermissionGroup {
  const localEntries = [...(local.permissions?.[behavior] ?? [])]
  const unmatched = [...localEntries]
  const inherited: string[] = []
  for (const entry of merged.permissions?.[behavior] ?? []) {
    const index = unmatched.indexOf(entry)
    if (index !== -1) {
      unmatched.splice(index, 1)
      continue
    }
    inherited.push(entry)
  }
  return { behavior, local: localEntries, inherited }
}

/** One skill row: its frontmatter, minus the body and the hook commands. */
function describeSkill(skill: SkillDefinition, enabled: boolean): WireSkillInfo {
  const info: WireSkillInfo = {
    name: skill.name,
    description: skill.description,
    enabled,
    // The parser defaults an absent `inclusion` to `manual`; the fallback is
    // for a definition that reached here from somewhere else.
    inclusion: skill.inclusion ?? 'manual',
    hasHooks: skill.hooks !== undefined,
  }
  if (skill.paths?.length) info.paths = [...skill.paths]
  if (skill.allowedTools?.length) info.allowedTools = [...skill.allowedTools]
  if (skill.model !== undefined) info.model = skill.model
  if (skill.effort !== undefined) info.effort = skill.effort
  if (skill.attachments?.length) info.attachments = skill.attachments.length
  return info
}

/**
 * One MCP server row: what it is, whether it is trusted, and what the last
 * connection attempt made of it.
 *
 * The configuration comes from the settings rather than from the live client —
 * `ManagedMcpClient` keeps its config private, and a server that failed to
 * connect has no client at all but still needs a row.
 */
function describeMcpServer(
  name: string,
  server: McpServerConfig,
  status: McpConnectionStatus,
  trusted: ReadonlySet<string>,
  locallyTrusted: ReadonlySet<string>,
): WireMcpServerInfo {
  const connected = status.connected.find((entry) => entry.name === name)
  const failed = status.failed.find((entry) => entry.name === name)
  const info: WireMcpServerInfo = {
    name,
    transport: server.transport,
    target:
      server.transport === 'stdio'
        ? [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
        : server.url ?? '',
    trusted: trusted.has(name),
    // Trust is unioned across layers, so a grant from above cannot be revoked
    // here. Granting is always possible; taking away is not.
    trustEditable: !trusted.has(name) || locallyTrusted.has(name),
    status: connected ? 'connected' : failed ? 'failed' : 'unknown',
  }
  if (connected) info.toolCount = connected.toolCount
  if (failed) info.error = failed.error
  return info
}

/** What one edit costs beyond the mutation itself. */
interface SettingsChangeEffect {
  /** The in-memory `Config` was changed and has to be saved before the reload. */
  saveConfig: boolean
  /** Every live lane of this project rebuilds its runtime after the reload. */
  rebuild: boolean
  /**
   * Which routing scope a rebuild re-resolves the model against. `'models'` for
   * everything that is not a provider edit: it keeps the current model key when
   * that key still resolves, which is what "rebuild but do not change model"
   * means.
   */
  scope: ProviderConfigChangeScope
  /**
   * Runs after `reloadSettings()`. For anything that reads the settings the
   * runtime now holds — an MCP reconnect would otherwise re-apply the trust list
   * from before the edit.
   */
  afterReload?: () => Promise<void>
}

/**
 * Applies one edit and reports what the shell owes it afterwards.
 *
 * Split by scope rather than one flat switch because the two halves write to
 * different places: provider edits mutate the in-memory `Config` (and are saved
 * by the caller), while everything else writes a settings layer or performs an
 * action. Exhaustive by `assertNeverChange` either way, so a new variant cannot
 * reach production as a silent no-op.
 */
async function applySettingsEffect<P extends ShellLaneProject, W extends ShellLaneWorkspace<PaneLike>>(
  entry: ProjectEntry<P, W>,
  change: SettingsChange,
): Promise<SettingsChangeEffect> {
  if (change.scope === 'provider') {
    return {
      saveConfig: true,
      rebuild: true,
      scope: applyProviderChange(entry.project.config, change),
    }
  }

  switch (change.kind) {
    case 'set-permission-entries':
      await setLocalPermissionEntries(entry.cwd, change.behavior, change.entries)
      // No rebuild: `reloadSettings()` pushes the new rules into every open
      // scope's gate, and replacing a runtime would drop its prompt cache for
      // nothing.
      return { saveConfig: false, rebuild: false, scope: 'models' }
    case 'set-startup-permission-mode':
      // Startup only, and deliberately so: the mode is read when a scope builds
      // its gate, so this reaches the *next* session rather than fighting with
      // the mode the user has toggled in an open one.
      await setLocalStartupPermissionMode(entry.cwd, change.mode)
      return { saveConfig: false, rebuild: false, scope: 'models' }
    case 'reload-agent-definitions':
      await entry.project.reloadAgentDefinitions()
      // A runtime hands its Agent tool the definitions that existed when it was
      // built, so without the rebuild the reload only reaches the next one.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-cache-ttl':
      await setLocalCacheTtl1h(entry.cwd, change.enabled)
      // `cacheRuntime` is captured at runtime construction, so this one does
      // need the rebuild.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-thinking':
      await setLocalThinking(entry.cwd, change.enabled)
      // Same reason as the cache TTL: the loop is handed its thinking config
      // when the runtime is built, so only a rebuild reaches an open session.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-context-management':
      entry.project.config.setContextManagement({ [change.field]: change.value })
      // No rebuild, because a rebuild would not help: the numbers are snapshotted
      // into the session scope at bootstrap, which is why the rows say so.
      return { saveConfig: true, rebuild: false, scope: 'models' }
    case 'set-skill-enabled':
      await setSkillEnabledLocally(entry.cwd, change.name, change.enabled)
      // The reload comes after `reloadSettings()` because `SkillsService` reads
      // the merged layers to decide what is switched on; the rebuild is for the
      // same reason the agent reload needs one — a runtime is handed the skill
      // list it was built with.
      return {
        saveConfig: false,
        rebuild: true,
        scope: 'models',
        afterReload: async () => {
          await entry.project.reloadSkills()
        },
      }
    case 'reload-skills':
      return {
        saveConfig: false,
        rebuild: true,
        scope: 'models',
        afterReload: async () => {
          await entry.project.reloadSkills()
        },
      }
    case 'set-mcp-trust':
      await setMcpServerTrustLocally(entry.cwd, change.name, change.trusted)
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    case 'reconnect-mcp':
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    default:
      return assertNeverChange(change)
  }
}

/**
 * Applies one provider edit to the config **in memory** and reports which
 * routing scope the runtimes must be re-resolved against.
 *
 * Nothing here saves: `applySettingsChange` owns the save/reload ordering, and
 * keeping the mutation separate is what lets a rejected reference check leave
 * the on-disk config untouched.
 *
 * Exhaustive by `assertNeverChange`, so a variant added to `SettingsChange`
 * cannot reach production as a silent no-op.
 */
function applyProviderChange(
  config: ShellLaneProject['config'],
  change: Extract<SettingsChange, { scope: 'provider' }>,
): ProviderConfigChangeScope {
  switch (change.kind) {
    case 'set-endpoint': {
      const existing = config.get().endpoints?.[change.name]
      const endpoint: Endpoint = { provider: change.provider }
      if (change.baseUrl !== undefined && change.baseUrl !== '') endpoint.baseUrl = change.baseUrl
      // An absent `apiKey` means "leave it alone", so the stored key is carried
      // forward. Clearing is `clear-endpoint-key`, precisely so this branch
      // never has to guess what an empty string meant.
      if (change.apiKey !== undefined) {
        if (change.apiKey !== '') endpoint.apiKey = change.apiKey
      } else if (existing?.apiKey !== undefined) {
        endpoint.apiKey = existing.apiKey
      }
      config.setEndpoint(change.name, endpoint)
      return 'endpoints'
    }
    case 'clear-endpoint-key': {
      const existing = config.get().endpoints?.[change.name]
      if (!existing) throw new Error(`No endpoint named ${change.name}`)
      const endpoint: Endpoint = { provider: existing.provider }
      if (existing.baseUrl !== undefined) endpoint.baseUrl = existing.baseUrl
      config.setEndpoint(change.name, endpoint)
      return 'endpoints'
    }
    case 'remove-endpoint':
      config.removeEndpoint(change.name)
      return 'endpoints'
    case 'set-model': {
      const model: ModelConfig = { model: change.model }
      if (change.provider !== undefined && change.provider !== '') model.provider = change.provider
      if (change.endpoint !== undefined && change.endpoint !== '') model.endpoint = change.endpoint
      if (change.contextWindow !== undefined) model.contextWindow = change.contextWindow
      if (change.maxOutputTokens !== undefined) model.maxOutputTokens = change.maxOutputTokens
      config.setModelConfig(change.key, model)
      return 'models'
    }
    case 'rename-model':
      // Rewrites every reference, routing included — which is why this is a
      // dedicated variant rather than a remove plus an add.
      config.renameModel(change.from, change.to)
      return 'models'
    case 'remove-model':
      config.removeModel(change.key)
      return 'models'
    case 'set-default-model':
      config.setDefaultModel(change.key)
      return 'models'
    case 'set-routing': {
      const routing = config.getRouting()
      config.setRouting({ ...routing, [change.role]: change.value })
      return 'routing'
    }
    case 'set-subagent-routing': {
      const routing = config.getRouting()
      config.setRouting({
        ...routing,
        subagent: { ...routing.subagent, [change.type]: change.value },
      })
      return 'routing'
    }
    default:
      return assertNeverChange(change)
  }
}

function assertNeverChange(value: never): never {
  throw new Error(`Unhandled settings change: ${JSON.stringify(value)}`)
}

export {
  runtimeHostSatisfiesShellLaneProject,
  sessionWorkspaceSatisfiesShellLaneWorkspace,
}
