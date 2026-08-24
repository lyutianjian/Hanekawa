import type { SessionMeta } from '../sessions/service.js'
import type { WirePaneInfo } from '../runtime/protocol/wire.js'

/**
 * The shell protocol: what the single desktop window's `__shell` lane carries.
 *
 * Session traffic (36 `HostCommand`s and their events) flows on per-pane lanes
 * untouched. This is the lane *beside* them — the one that speaks for the
 * window rather than for any one session, so the renderer can ask about and
 * steer the lane topology itself.
 *
 * Deliberately small. Commands answer "what lanes exist", "open or focus a
 * session as a lane", and "open a project"; events announce topology changes
 * and activation requests. Settings live here too in phase 4d — a settings
 * screen is a window-level surface, not a session view — which is why the lane
 * exists from the start rather than being bolted on later.
 *
 * The reply/fail envelopes are the same shapes `SessionClient` speaks, so the
 * renderer's shell client reuses `PendingRequests` and the fail path unchanged.
 * Only this file is shared with the renderer, so it must stay browser-safe:
 * type-only imports, no zod (the host-side schemas live in `shellHost.ts`),
 * no Node builtins.
 */

/**
 * The reserved lane key for shell traffic. Not a lane `ShellHost` mints — it
 * exists on both muxes from construction and no session may ever claim it.
 */
export const SHELL_LANE = '__shell'

/**
 * A wire pane plus the lane key it currently lives on.
 *
 * `paneId` (the session id) moves under `/clear` and `/resume`; the lane key
 * does not. Everything on the renderer that wants a stable handle on an open
 * session — tab rows, close buttons, activation — goes through `lane`.
 */
export interface WireLaneInfo extends WirePaneInfo {
  lane: string
}

// --- renderer → main ---------------------------------------------------------

export type ShellCommand =
  /** The full lane topology, across every open project. */
  | { type: 'panes'; id: string }
  /**
   * Opens a session as a lane, or focuses its existing lane. Without
   * `sessionId` a fresh draft is minted. `projectRoot` is the normalized key
   * the `lanes` events carry; omitted, the first open project answers.
   */
  | { type: 'open-session'; id: string; sessionId?: string; title?: string; projectRoot?: string }
  /**
   * Every session on disk, per project — the sidebar's history, which is a
   * superset of the lane topology (most sessions are not open).
   *
   * A pull rather than a pushed event: the renderer already refreshes on every
   * topology change and at turn end, and a push would either fire on every
   * snapshot tick or need its own change detection on the store.
   */
  | { type: 'list-sessions'; id: string }
  /**
   * Deletes a session: its lane if one is open, its three files, and its shadow
   * repo. `projectRoot` is required — sessions live per project, and guessing
   * would delete out of the wrong one.
   */
  | { type: 'delete-session'; id: string; projectRoot: string; sessionId: string }
  /**
   * Hands a directory to the shell, exactly like the `open-project` host
   * command: `ok` means accepted, not that a project is open — without `path`
   * the user still has a directory dialog to answer.
   */
  | { type: 'open-project'; id: string; path?: string }
  /**
   * The settings screen's whole read model for one project, in one pull.
   * Without `projectRoot` the first open project answers, matching
   * `open-session`.
   */
  | { type: 'get-settings'; id: string; projectRoot?: string }
  /**
   * One edit. A single command carrying a discriminated `SettingsChange`
   * rather than ten commands: the four settings cards will otherwise add a
   * command apiece, and every one of them would repeat the same
   * project-lookup / save / reload / fan-out choreography.
   */
  | { type: 'settings-change'; id: string; projectRoot: string; change: SettingsChange }
  /**
   * Retitles a session. `sessionId` may be a prefix — the host resolves it,
   * for the same reason `delete-session` does.
   */
  | { type: 'rename-session'; id: string; projectRoot: string; sessionId: string; title: string }

// --- settings ----------------------------------------------------------------

/** The settings screen's left-hand categories. */
export type SettingsCategory = 'provider' | 'permissions' | 'agent' | 'general'

/**
 * An endpoint as the screen shows it.
 *
 * The field is `apiKeyMasked`, never `apiKey`, and that naming is the actual
 * safeguard: a masked value is then not assignable to any `SettingsChange`
 * field, so "render the key, send it back on save" cannot typecheck.
 */
export interface WireEndpointInfo {
  name: string
  provider: string
  baseUrl?: string
  apiKeyMasked?: string
}

export interface WireModelInfo {
  key: string
  model: string
  provider?: string
  endpoint?: string
  contextWindow?: number
  maxOutputTokens?: number
  maxEffort?: string
  /** Only when set inline on the model rather than inherited from an endpoint. */
  baseUrl?: string
  apiKeyMasked?: string
  /**
   * `resolveModel(key) !== undefined`. Carried so the row can be drawn *and*
   * explain itself: a model that is configured but cannot run must say so
   * rather than silently vanish from the list (the 4c invariant).
   */
  resolves: boolean
}

export interface WireRoutingInfo {
  main: string
  plan: string
  compact: string
  /** An array, not a Record: it pins the order the selects are drawn in. */
  subagent: Array<{ type: string; value: string }>
}

/**
 * One permission group, split by the file it lives in.
 *
 * Split rather than flagged per entry because that is the shape of the
 * constraint: `mergeSettings` *concatenates* `permissions.allow/deny/ask`
 * across layers, so the only group this screen can rewrite is the local one,
 * and writing a merged group back would copy every inherited entry into the
 * local file.
 */
export interface WirePermissionGroup {
  behavior: 'allow' | 'deny' | 'ask'
  local: string[]
  inherited: string[]
}

export interface WirePermissionsInfo {
  /** `<cwd>/.myagent/settings.local.json` — the screen says what it writes. */
  localPath: string
  /**
   * The startup mode as merged. Editable whatever layer set it: unlike the
   * groups, `permissions.mode` is last-writer-wins, and the local layer is last.
   */
  mode: 'default' | 'acceptEdits' | 'bypass'
  /** Whether the local layer is what set the mode, for the row's own detail. */
  modeIsLocal: boolean
  groups: WirePermissionGroup[]
}

/**
 * An agent definition as the screen shows it: read-only, field by field.
 *
 * Projected rather than shipped because `BaseAgentDefinition` carries
 * `getSystemPrompt` — a function, which `structuredClone` refuses outright.
 */
export interface WireAgentDefinitionInfo {
  type: string
  description: string
  /** A built-in cannot be edited by editing a file; a custom one can. */
  builtIn: boolean
  permissionMode?: string
  /** Absent means every tool: the definition says `tools: ['*']` or nothing. */
  tools?: string[]
  model?: string
  maxTurns: number
  isReadOnlyAgent: boolean
  /** `routing.subagent[type]`, or `inherit`. The one editable field here. */
  routing: string
}

export interface WireMcpServerInfo {
  name: string
  transport: 'stdio' | 'sse'
  /** The command with its args, or the URL — whichever the transport uses. */
  target: string
  trusted: boolean
  /**
   * False when a layer above trusts it. `mcp.trustedServers` is *unioned*
   * across layers, so this screen can grant trust but cannot take that grant
   * away — and a toggle that silently does nothing is worse than a disabled one.
   */
  trustEditable: boolean
  status: 'connected' | 'failed' | 'unknown'
  toolCount?: number
  error?: string
}

/**
 * The six context-budget numbers, in the order the screen draws them.
 *
 * Exported as a value because both the schema and the rows iterate it; spelled
 * once so a seventh field cannot be added to one and forgotten in the other.
 */
export const CONTEXT_MANAGEMENT_FIELDS = [
  'contextWindow',
  'summaryOutputTokens',
  'autoCompactBufferTokens',
  'manualCompactBufferTokens',
  'microCompactThresholdRatio',
  'autoCompactThresholdRatio',
] as const

export type WireContextManagementField = (typeof CONTEXT_MANAGEMENT_FIELDS)[number]

/** Merged over the defaults, so every field has a number to draw. */
export type WireContextManagementInfo = Record<WireContextManagementField, number>

export interface WireGeneralInfo {
  /** `<cwd>/.myagent/settings.local.json`, same file the permission groups use. */
  localPath: string
  /**
   * `cache.ttl1h`. Absent is not `false`: unset falls through to the
   * `MYAGENT_PROMPT_CACHE_1H` environment variable, and the row says so.
   */
  cacheTtl1h?: boolean
}

export interface WireSettingsSnapshot {
  projectRoot: string
  projectName: string
  /** `getSaveTarget()` — the screen says which file it is about to write. */
  saveTarget: string
  endpoints: WireEndpointInfo[]
  models: WireModelInfo[]
  routing: WireRoutingInfo
  defaultModel?: string
  /**
   * Read-only for now: `ConfigService` has `setDefaultModel` but no
   * `setFallbackModel` / `setCompactModel`, and inventing them belongs to a
   * separate, tested change rather than to the screen that wants them.
   */
  fallbackModel?: string
  compactModel?: string
  /** `SUPPORTED_PROVIDER_NAMES` — the provider select's choices. */
  providers: string[]
  /** The built-in subagent types unioned with any the routing already names. */
  subagentTypes: string[]
  permissions: WirePermissionsInfo
  agents: WireAgentDefinitionInfo[]
  mcpServers: WireMcpServerInfo[]
  /** From `config.json`, not the settings layers — see `setContextManagement`. */
  contextManagement: WireContextManagementInfo
  general: WireGeneralInfo
}

/**
 * One settings edit.
 *
 * `scope` picks the card and `kind` the operation. `kind` is unique across the
 * whole union, not just within a scope: the host's schema table is keyed by it
 * and so is the dispatch switch.
 *
 * `apiKey` absent means "leave it alone"; clearing is its own variant rather
 * than `apiKey: null`, because an optional field cannot distinguish "the user
 * did not touch this" from "the user emptied it" once it has round-tripped
 * through a form whose input was seeded with a mask.
 */
export type SettingsChange =
  | { scope: 'provider'; kind: 'set-endpoint'; name: string; provider: string; baseUrl?: string; apiKey?: string }
  | { scope: 'provider'; kind: 'clear-endpoint-key'; name: string }
  | { scope: 'provider'; kind: 'remove-endpoint'; name: string }
  | {
      scope: 'provider'
      kind: 'set-model'
      key: string
      model: string
      provider?: string
      endpoint?: string
      contextWindow?: number
      maxOutputTokens?: number
    }
  | { scope: 'provider'; kind: 'rename-model'; from: string; to: string }
  | { scope: 'provider'; kind: 'remove-model'; key: string }
  | { scope: 'provider'; kind: 'set-default-model'; key: string }
  | { scope: 'provider'; kind: 'set-routing'; role: 'main' | 'plan' | 'compact'; value: string }
  | { scope: 'provider'; kind: 'set-subagent-routing'; type: string; value: string }
  /**
   * The whole group, not one entry. Rewriting the group is what makes a removal
   * possible and what keeps inherited entries out of the local file; the
   * renderer therefore sends `local` plus or minus one line.
   */
  | { scope: 'permissions'; kind: 'set-permission-entries'; behavior: 'allow' | 'deny' | 'ask'; entries: string[] }
  | { scope: 'permissions'; kind: 'set-startup-permission-mode'; mode: 'default' | 'acceptEdits' | 'bypass' }
  /** An action, not a write: re-reads `.myagent/agents/` and rebuilds runtimes. */
  | { scope: 'agent'; kind: 'reload-agent-definitions' }
  | { scope: 'general'; kind: 'set-cache-ttl'; enabled: boolean }
  | { scope: 'general'; kind: 'set-context-management'; field: WireContextManagementField; value: number }
  | { scope: 'general'; kind: 'set-mcp-trust'; name: string; trusted: boolean }
  /** Also an action. Never prompts for trust — see `ProjectRuntime.reloadMcpServers`. */
  | { scope: 'general'; kind: 'reconnect-mcp' }

// --- main → renderer ---------------------------------------------------------

export type ShellEvent =
  /**
   * The lane topology changed. Pushed on every open, close and session switch
   * (a switch moves `paneId` under a lane, which is a topology change even
   * though no lane opened or closed).
   */
  | { type: 'lanes'; lanes: WireLaneInfo[] }
  /**
   * A request that the renderer make `lane` the active pane. Activation is a
   * renderer concern in a single window — the main process can only ask.
   */
  | { type: 'activate'; lane: string }
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'fail'; id: string; message: string }

// --- reply payloads ----------------------------------------------------------

export interface WireShellPanesResult {
  lanes: WireLaneInfo[]
}

export interface WireShellOpenSessionResult {
  lane: string
  pane: WireLaneInfo
}

/**
 * A session as the sidebar needs it: the four fields a row reads.
 *
 * Projected field by field rather than shipping `SessionMeta`, which was the
 * first attempt. `SessionMeta` is already a wire type elsewhere
 * (`WireSessionsResult`, `session-changed`) so reusing it looked free — but this
 * command answers with *every* session in *every* open project, and two of the
 * fields nobody here reads grow without bound: `checkpoints` gains an entry per
 * turn, and `denialState` accumulates streaks. At a few hundred sessions that is
 * hundreds of kilobytes `structuredClone`d across the preload boundary on every
 * pull, and retained for as long as the renderer holds the list.
 */
export interface WireSessionSummary {
  id: string
  title?: string
  updatedAt: string
  messageCount: number
}

/** One project's session history. */
export interface WireShellProjectSessions {
  projectRoot: string
  projectName: string
  sessions: WireSessionSummary[]
}

export interface WireShellSessionsResult {
  /** In the order projects were opened, which is `ProjectDirectory`'s order. */
  projects: WireShellProjectSessions[]
}

export interface WireShellDeleteSessionResult {
  ok: true
}

export interface WireShellOpenProjectResult {
  ok: true
}

export interface WireShellSettingsResult {
  settings: WireSettingsSnapshot
  /**
   * Every open project. Settings are per project and N may be open, so the
   * screen needs a selector — the sidebar's grouping does not carry over here.
   */
  projects: Array<{ projectRoot: string; projectName: string }>
}

export interface WireShellSettingsChangeResult {
  /** A fresh snapshot. The renderer never re-derives one from the change. */
  settings: WireSettingsSnapshot
  /** How many live lanes of that project rebuilt their runtime. */
  rebuiltLanes: number
}

export interface WireShellRenameSessionResult {
  ok: true
  title: string
}

