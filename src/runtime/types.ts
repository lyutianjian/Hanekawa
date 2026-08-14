import type { AgentLoop, ActiveModelRuntime, AgentRunOverrides } from '../harness/loop.js'
import type { PlanModeManager } from '../harness/planModeManager.js'
import type { PermissionGate } from '../harness/permissions.js'
import type { AgentRunResult, SessionRecord } from '../harness/types.js'
import type { RuntimeDiagnostic } from '../harness/diagnostics.js'
import type { ConfigService, ModelConfig } from '../config/service.js'
import type { EffortLevel } from '../config/effort.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { McpServerConfig } from '../services/mcp/index.js'
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
 * Everything a host needs to render and drive an agent, with no terminal or
 * React dependency. Produced by `bootstrap()`.
 */
export interface RuntimeHost {
  cwd: string
  config: ConfigService
  store: SessionStore
  session: SessionMeta
  permissionGate: PermissionGate
  backgroundTasks: BackgroundTaskRegistry
  bridges: UiBridges
  initialModelKey: string
  /** Startup effort after clamping to the model's max, when it is a level. */
  initialEffort: EffortLevel | undefined
  /** Effort as configured in settings, before clamping. */
  configuredEffortLevel: EffortLevel
  /** Includes any synthetic records written while reconciling orphaned agents. */
  existingRecords: SessionRecord[]
  /** True when the last turn was interrupted and can be resumed with "continue". */
  hasRecoverableInterruption: boolean
  diagnostics: RuntimeDiagnostic[]
  mcp: McpConnectionStatus
  createRuntime(
    modelKey: string,
    session: SessionMeta,
    records?: readonly SessionRecord[],
  ): AgentSession
  createActiveModelRuntime(modelKey: string): ActiveModelRuntime
  reloadAgentDefinitions(): Promise<number>
  shutdown(reason: string): Promise<void>
}
