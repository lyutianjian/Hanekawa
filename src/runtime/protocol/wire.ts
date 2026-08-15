import type { EffortLevel } from '../../config/effort.js'
import type { DestructiveCommandWarning } from '../../harness/destructiveCommands.js'
import type {
  PermissionDecisionSource,
  PermissionMode,
  PermissionRule,
} from '../../harness/permissions.js'
import type { RiskLevel, SessionRecord } from '../../harness/types.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import type { CheckpointWithDiff } from '../../services/checkpoint/checkpointService.js'
import type { FileToolPreview } from '../../services/fileToolPreview.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { SessionControllerSnapshot, SessionEvent } from '../sessionController.js'
import type { StartupNotice } from '../startupNotices.js'

/**
 * The wire format between a runtime host and whatever renders it.
 *
 * Every payload here is structured-clone-safe. `SessionEvent` and
 * `SessionControllerSnapshot` already are and travel verbatim; the three types
 * below exist because their in-process counterparts are not:
 *
 * - `AgentRunOverrides.model` holds a live `ModelProvider`
 * - `RuntimeSlotSnapshot.session` holds the `AgentLoop` and the provider
 * - `PermissionRequest.tool` holds a zod schema and `execute`, and its
 *   `onAlwaysAllow` is a callback
 *
 * Anything added here must survive `structuredClone`. `test/protocolWire.test.ts`
 * enforces that for the event side.
 */

// --- host → client ----------------------------------------------------------

export type HostEvent =
  /** The controller's ordered stream, forwarded untouched. */
  | { type: 'session-event'; event: SessionEvent }
  /**
   * Pull state. `subagentProgress` rides along because the controller exposes
   * it as a live `Map` that a `Map` cannot cross the boundary as.
   */
  | { type: 'snapshot'; snapshot: SessionControllerSnapshot; subagentProgress: Array<[string, string]> }
  | { type: 'runtime-snapshot'; snapshot: WireRuntimeSnapshot }
  /**
   * Push, because the registry is a `useSyncExternalStore` source. The host
   * coalesces these: `changed()` fires on every output chunk of every running
   * shell, which would otherwise be an IPC firehose.
   */
  | { type: 'background-tasks'; tasks: BackgroundTaskSnapshot[] }
  /** A blocking question for the UI. The client must eventually answer it. */
  | { type: 'ui-request'; request: UiRequest }
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'fail'; id: string; message: string }

// --- client → host ----------------------------------------------------------

export type HostCommand =
  /** Client attached. The host replays both snapshots so the UI can paint. */
  | { type: 'hello'; id: string }
  | { type: 'submit'; id: string; input: string; overrides?: WireRunOverrides }
  /**
   * No signal crosses the boundary — the host owns the `AbortController`. The
   * reason is a sentinel the loop reads: `'user-cancel'` writes a
   * `turn_interruption` record, `'exit'` deliberately does not.
   */
  | { type: 'interrupt'; id: string; reason: InterruptReason }
  /** Reloads *records*, unlike the `reload-*` commands below. */
  | { type: 'reload'; id: string }
  | { type: 'retarget'; id: string; sessionId: string }
  | { type: 'run-tool'; id: string; name: string; input: unknown }
  | { type: 'checkpoints'; id: string }
  | { type: 'restore-code'; id: string; commitHash: string }
  | { type: 'set-model'; id: string; modelKey: string }
  | { type: 'set-effort'; id: string; level: string; persist?: boolean }
  | { type: 'set-permission-mode'; id: string; mode: PermissionMode }
  | { type: 'ui-response'; requestId: string; response: UiResponse }
  // --- models ---------------------------------------------------------------
  | { type: 'list-models'; id: string }
  | { type: 'resolve-model'; id: string; input: string }
  | { type: 'set-default-model'; id: string; reference: string }
  // --- sessions -------------------------------------------------------------
  | { type: 'list-sessions'; id: string }
  | { type: 'create-session'; id: string; title?: string }
  // --- host-side reloads ----------------------------------------------------
  | { type: 'reload-agents'; id: string }
  | { type: 'reload-skills'; id: string }
  | { type: 'reload-settings'; id: string }
  // --- background tasks -----------------------------------------------------
  | { type: 'list-background-tasks'; id: string }
  | { type: 'peek-task-output'; id: string; taskId: string; maxBytes?: number }
  | { type: 'kill-task'; id: string; taskId: string; reason?: string }
  // --- lifecycle ------------------------------------------------------------
  | { type: 'shutdown'; id: string; reason: string }

export type InterruptReason = 'user-cancel' | 'exit'

// --- payload replacements ---------------------------------------------------

/**
 * `AgentRunOverrides` minus everything that cannot be cloned.
 *
 * `model` becomes a key the host resolves through `createActiveModelRuntime`;
 * `hooks` is deliberately absent, because hooks come from host-side settings
 * and a client must never be able to inject them.
 */
export interface WireRunOverrides {
  allowedTools?: string[]
  modelKey?: string
  effort?: EffortLevel
  skillName?: string
  skillArgs?: string
  displayInput?: string
}

/** `RuntimeSlotSnapshot` projected to metadata. Never carries `apiKey`. */
export interface WireRuntimeSnapshot {
  modelKey: string
  model: string
  providerName?: string
  contextWindow?: number
  maxEffort?: EffortLevel
  effort: string
  permissionMode: PermissionMode
}

/**
 * `PermissionRequest` with the `Tool` reduced to the two fields a dialog reads
 * and `onAlwaysAllow` reduced to a flag. The host keeps the real request and
 * invokes the callback when the answer comes back.
 *
 * `preview` and `destructiveWarnings` are derived here rather than by the
 * viewer: both need host-side code (the filesystem, and the shell analyzer in
 * `harness/`), and a renderer must be able to draw this dialog without
 * importing either.
 */
export interface PermissionRequestDto {
  toolName: string
  riskLevel: RiskLevel
  input: unknown
  reason: string
  source: PermissionDecisionSource
  matchedRule?: PermissionRule
  alwaysAllowRule?: PermissionRule
  denialStreak: number
  /** False when the gate offered no "always allow" affordance for this call. */
  canAlwaysAllow: boolean
  /** Already bounded by `capFileToolPreview`; absent for non-file tools. */
  preview?: FileToolPreview
  destructiveWarnings: DestructiveCommandWarning[]
}

// --- the four blocking UI requests -----------------------------------------

export type UiRequest =
  | { kind: 'permission'; requestId: string; payload: PermissionRequestDto }
  | { kind: 'ask-user-question'; requestId: string; payload: AskUserQuestionRequest }
  | { kind: 'enter-plan'; requestId: string }
  | { kind: 'exit-plan'; requestId: string; payload: ExitDialogInput }

export type UiResponse =
  /** `alwaysAllow` must be honored before the approval resolves; see host.ts. */
  | { kind: 'permission'; approved: boolean; alwaysAllow?: boolean }
  | { kind: 'ask-user-question'; result: AskUserQuestionResult }
  | { kind: 'enter-plan'; approved: boolean }
  | { kind: 'exit-plan'; decision: ExitPlanDecision }

/**
 * What each request kind resolves to when the client is gone.
 *
 * These mirror the bridges' own fallbacks and are asymmetric on purpose:
 * denying a tool is safe, rejecting a plan exit is safe, but *entering* plan
 * mode only ever restricts the agent, so it approves. Do not unify them.
 */
export const UI_REQUEST_FALLBACKS = {
  permission: (): UiResponse => ({ kind: 'permission', approved: false }),
  'ask-user-question': (): UiResponse => ({
    kind: 'ask-user-question',
    result: { kind: 'rejected', feedback: 'The UI disconnected before answering.' },
  }),
  'enter-plan': (): UiResponse => ({ kind: 'enter-plan', approved: true }),
  'exit-plan': (): UiResponse => ({
    kind: 'exit-plan',
    decision: { kind: 'reject', feedback: '' },
  }),
} as const satisfies Record<UiRequest['kind'], () => UiResponse>

// --- command result payloads ------------------------------------------------

export interface WireCheckpointsResult {
  checkpoints: CheckpointWithDiff[]
}

export interface WireReloadResult {
  records: SessionRecord[]
}

export interface WireRestoreCodeResult {
  success: boolean
  error?: string
}

export interface WireRunToolResult {
  ok: boolean
  content: string
  errorCode?: string
}

/**
 * What a shell needs before it can paint its first frame.
 *
 * Startup-shaped state rides here rather than becoming events or extra round
 * trips; anything that changes later gets a command instead. `records` is the
 * host's ledger at attach time — without it a fresh renderer has an empty
 * transcript until it asks for a reload.
 */
export interface WireHelloResult {
  sessionId: string
  session: SessionMeta
  cwd: string
  records: SessionRecord[]
  notices: StartupNotice[]
  hasRecoverableInterruption: boolean
  initialQueuedPrompt?: string
  /** Before clamping, for a picker that wants to show the configured value. */
  configuredEffortLevel: EffortLevel
}

/**
 * One entry of `config.models`, built field by field.
 *
 * Never spread a `ModelConfig` into this: `resolveModel` folds the endpoint's
 * `apiKey` and `baseUrl` into what it returns, so a spread would ship every
 * key the user has configured to the renderer. Fields are absent when the
 * entry does not resolve (missing or unknown endpoint).
 */
export interface WireModelInfo {
  key: string
  model?: string
  provider?: string
  contextWindow?: number
  maxEffort?: EffortLevel
}

export interface WireModelsResult {
  /** Every configured key, resolvable or not — parity with `availableModelKeys`. */
  models: WireModelInfo[]
  defaultModelKey?: string
}

export interface WireResolveModelResult {
  modelKey?: string
}

/** `SessionMeta` crosses verbatim: it is already the JSON shape in index.json. */
export interface WireSessionsResult {
  sessions: SessionMeta[]
}

export interface WireSessionSwitchResult {
  session: SessionMeta
  records: SessionRecord[]
  notices: StartupNotice[]
}

export interface WireReloadCountResult {
  count: number
}

export interface WireReloadSettingsResult {
  needsRuntimeRebuild: boolean
  /** True when the host already swapped the runtime on your behalf. */
  rebuilt: boolean
  modelKey: string
}

export interface WireEffortResult {
  effort: string
  persisted: boolean
}

export interface WireBackgroundTasksResult {
  tasks: BackgroundTaskSnapshot[]
}

export interface WireTaskOutputResult {
  output: string
}

export interface WireTaskResult {
  task?: BackgroundTaskSnapshot
}
