import type { SessionRecord } from '../harness/types.js'
import type { EffortLevel } from '../config/effort.js'
import type { Hooks } from '../harness/hooks.js'

export interface CommandDefinition {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  isHidden?: boolean
  isEnabled?: () => boolean
  run: (args: string, context: CommandContext) => Promise<string | void>
}

export interface CommandUsage {
  inputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  cost?: number
  currency?: string
}

export interface CommandSessionMetricsSummary {
  totalCacheHitRate: number | null
  totalTurns: number
  firstBreakTurnCount: number | null
  cacheBreakCount: number
  averageCompactIntervalTurns: number | null
}

export interface CommandModelInfo {
  key: string
  model: string
  providerName: string
}

export type SetModelResult =
  | { ok: true; model: CommandModelInfo }
  | { ok: false; message: string; availableModels?: string[] }

export interface CommandSubagentDetails {
  task?: Extract<SessionRecord, { type: 'subagent_task' }>
  transcript?: Extract<SessionRecord, { type: 'subagent_transcript' }>
  transcriptRecords: SessionRecord[]
}

export interface CommandSubagentCleanupResult {
  dryRun: boolean
  entries: Array<{
    agentId: string
    status: string
    worktreePath: string
    exists: boolean
    removed?: boolean
    error?: string
  }>
}

export interface CommandSubmitQueryOptions {
  allowedTools?: string[]
  model?: string
  effort?: EffortLevel
  hooks?: Hooks
  skillName?: string
  skillArgs?: string
  displayInput?: string
}

export interface CommandShellResult {
  ok: boolean
  content: string
  errorCode?: string
}

export type CommandView =
  | {
      kind: 'list'
      title: string
      subtitle?: string
      items: Array<{ id: string; label: string; description?: string }>
    }
  | {
      kind: 'info'
      title: string
      subtitle?: string
      sections: Array<{
        title?: string
        rows: Array<{ label: string; value: string; tone?: 'normal' | 'success' | 'warning' | 'error' }>
      }>
    }

export interface CommandContext {
  cwd: string
  sessionId: string
  writeLine: (msg: string) => void
  openCommandView?: (view: CommandView) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  repairRecords?: () => Promise<{ repairedCount: number; diagnostics: Array<{ message: string }> }>
  resetCompactFailureCount?: () => Promise<void>
  getUsage?: () => CommandUsage
  getSessionMetricsSummary?: () => Promise<CommandSessionMetricsSummary | null>
  getModel?: () => CommandModelInfo
  setModel?: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  getEffort?: () => string
  setEffort?: (level: string) => void | Promise<void>
  openModelPicker?: () => void
  openEffortPicker?: () => void
  reloadAgentDefinitions?: () => Promise<number>
  /** Re-reads `.myagent/skills/` and re-registers their slash commands. */
  reloadSkills?: () => Promise<number>
  getPermissionMode?: () => string
  enterPlanMode?: () => void | Promise<void>
  readPlanFile?: () => Promise<{ path: string; content: string | null }>
  openPlanFile?: () => Promise<{ message: string }>
  submitQuery?: (input: string, options?: CommandSubmitQueryOptions) => Promise<void>
  runShellCommand?: (command: string) => Promise<CommandShellResult>
  openProviderPanel?: () => void
  openBackgroundTasks?: () => void
  openResumePicker?: () => void
  /** `/rewind`: the checkpoint panel. Terminal-side this is also Escape-Escape. */
  openRewindPanel?: () => void
  listSubagentTasks?: () => Promise<Array<Extract<SessionRecord, { type: 'subagent_task' }>>>
  getSubagentDetails?: (agentIdOrPrefix: string) => Promise<CommandSubagentDetails | null>
  cleanupSubagentWorktrees?: (options: { apply: boolean }) => Promise<CommandSubagentCleanupResult>
}

export type CommandResult =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'message'; text: string }
