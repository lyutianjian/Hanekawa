import type { AgentLoop, ActiveModelRuntime, AgentRunOverrides } from '../harness/loop.js'
import type { PlanModeManager } from '../harness/planModeManager.js'
import type { PermissionGate } from '../harness/permissions.js'
import type { SystemPromptSectionCache } from '../harness/sections.js'
import type { AgentRunResult, SessionRecord } from '../harness/types.js'
import type { RuntimeDiagnostic } from '../harness/diagnostics.js'
import type { ConfigService, ModelConfig } from '../config/service.js'
import type { EffortLevel } from '../config/effort.js'
import type { MyAgentSettings } from '../config/settings.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import type { BaseAgentDefinition } from '../tools/agentTool.js'
import type { UiBridges } from './bridges.js'

/**
 * One assembled agent runtime: a loop, its plan-mode manager, and the model it
 * is bound to. A new session is created for every model switch, `/clear`, and
 * resume; the previous one must be `dispose()`d or its tool set leaks.
 *
 * `loop` is exposed deliberately — hosts may drive it directly. The methods are
 * a thin convenience layer, not a wall.
 */
export interface AgentSession {
  readonly loop: AgentLoop
  readonly planModeManager: PlanModeManager
  readonly modelKey: string
  readonly modelConfig: ModelConfig
  readonly providerName: string
  run(
    input: string,
    signal?: AbortSignal,
    messageId?: string,
    overrides?: AgentRunOverrides,
  ): Promise<AgentRunResult>
  dispose(): void
}

export interface McpConnectionStatus {
  connected: Array<{ name: string; toolCount: number }>
  failed: Array<{ name: string; error: string }>
}

export interface BootstrapOptions {
  cwd: string
  /** Already initialized: resolving `session` requires it. */
  store: SessionStore
  session: SessionMeta
  /**
   * Asked once per untrusted MCP server, before any UI owns stdin. Returning
   * false records the server as failed and startup continues (fail-open).
   */
  confirmMcpTrust: (name: string, server: McpServerConfig) => Promise<boolean>
}

/**
 * The project-wide half of a runtime: everything one `cwd` has exactly one of.
 *
 * Tools, MCP connections and background tasks are shared because they belong to
 * the project rather than to any one conversation. Anything a *session* owns is
 * on {@link SessionScope} instead, and the split is what lets one process hold
 * several concurrent sessions without them reaching into each other.
 */
export interface ProjectRuntime {
  cwd: string
  config: ConfigService
  store: SessionStore
  backgroundTasks: BackgroundTaskRegistry
  /**
   * The slash commands for this project. Per-project rather than module-level
   * because skill commands are read from `<cwd>/.myagent/skills/`, so a shared
   * one leaks the second project's skills into the first.
   */
  commands: CommandRegistry
  /**
   * The MCP servers as they currently stand. Mutated in place by
   * {@link ProjectRuntime.reloadMcpServers} rather than replaced: a holder of
   * this object would otherwise keep reading a snapshot from startup.
   */
  mcp: McpConnectionStatus
  initialModelKey: string
  /** Startup effort after clamping to the model's max, when it is a level. */
  initialEffort: EffortLevel | undefined
  /** Effort as configured in settings, before clamping. */
  configuredEffortLevel: EffortLevel
  createActiveModelRuntime(modelKey: string): ActiveModelRuntime
  /**
   * Opens an independent scope for `session`: its own UI bridges, permission
   * gate and prompt-section cache. Callers must `dispose()` what they open.
   */
  openScope(session: SessionMeta): Promise<SessionScope>
  /**
   * The settings the runtime is currently running on — merged, and live: it is
   * the same object `reloadSettings()` replaces. Read it rather than re-reading
   * the layers off disk, or a caller sees a different merge than the loop does.
   */
  getSettings(): MyAgentSettings
  /**
   * The built-in agent definitions merged with the project's own, which is what
   * a runtime hands to its Agent tool. Read-only inspection; editing them means
   * editing the files under `.myagent/agents/`.
   */
  listAgentDefinitions(): readonly BaseAgentDefinition[]
  reloadAgentDefinitions(): Promise<number>
  /** Re-reads `.myagent/skills/` and re-registers their slash commands. */
  reloadSkills(): Promise<number>
  /**
   * Closes every MCP client, drops its tools, and connects the servers the
   * current settings name.
   *
   * Untrusted servers are *not* prompted for here — a reload can happen while
   * the UI owns the screen, and there is nowhere for a pre-channel prompt to
   * live. They are reported as `not trusted`, which the trust setting exists to
   * fix.
   */
  reloadMcpServers(): Promise<void>
  /**
   * Re-reads the settings layers. Permission rules and the config layer take
   * effect immediately — for *every* open scope — while hooks are captured at
   * runtime construction, so `needsRuntimeRebuild` tells the caller when to
   * replace the runtime.
   */
  reloadSettings(): Promise<{ needsRuntimeRebuild: boolean }>
  /** Stops background tasks and MCP clients, and disposes every open scope. */
  shutdown(reason: string): Promise<void>
}

/**
 * One conversation's worth of state.
 *
 * Every member here holds state that is meaningless — or actively wrong —
 * shared between two sessions running at once:
 *
 * - `bridges` has a single handler slot per proxy, so two scopes sharing one set
 *   would route the second one's permission prompts to the first one's UI.
 * - `permissionGate` owns the mode, the pre-plan mode, the session rules and the
 *   denial counters. Shared, an "always allow" in one session silently allows in
 *   the other, and entering plan mode drags the other session in with it.
 * - `promptSections` caches the `# Environment` block, which embeds the model
 *   name — shared, a session sends a system prompt naming a different session's
 *   model.
 *
 * `createRuntime` is per-scope because it closes over the three above.
 */
export interface SessionScope {
  session: SessionMeta
  bridges: UiBridges
  permissionGate: PermissionGate
  promptSections: SystemPromptSectionCache
  createRuntime(
    modelKey: string,
    session: SessionMeta,
    records?: readonly SessionRecord[],
  ): AgentSession
  /** Includes any synthetic records written while reconciling orphaned agents. */
  existingRecords: SessionRecord[]
  /** True when the last turn was interrupted and can be resumed with "continue". */
  hasRecoverableInterruption: boolean
  /**
   * What to surface when this scope attaches. The initial scope also carries the
   * project's startup diagnostics, since those need showing exactly once and
   * that is the scope which shows them.
   */
  diagnostics: RuntimeDiagnostic[]
  /**
   * Releases the bridges so nothing is left parked on a UI that is gone. Does
   * not touch the project, and does not dispose runtimes — those belong to
   * whichever `RuntimeSlot` holds them.
   */
  dispose(): void
}

/**
 * Everything a single-session host needs to render and drive an agent, with no
 * terminal or React dependency. Produced by `bootstrap()`.
 *
 * A project runtime *merged with its initial scope*, because that is exactly
 * what a one-session shell wants: `host.permissionGate` and `host.bridges` mean
 * the only session there is. A shell that opens a second one calls
 * `openScope()` and keeps the two halves apart, which is what `SessionHost`
 * does.
 */
export type RuntimeHost = ProjectRuntime & SessionScope
