export interface CommandDefinition {
  name: string
  description: string
  argumentHint?: string
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

export interface CommandContext {
  cwd: string
  sessionId: string
  writeLine: (msg: string) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  repairRecords?: () => Promise<{ repairedCount: number; diagnostics: Array<{ message: string }> }>
  resetCompactFailureCount?: () => Promise<void>
  getUsage?: () => CommandUsage
  getSessionMetricsSummary?: () => Promise<CommandSessionMetricsSummary | null>
  getModel?: () => CommandModelInfo
  setModel?: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  runVerification?: (args: string) => Promise<string>
  reloadAgentDefinitions?: () => Promise<number>
  getPermissionMode?: () => string
  setPermissionMode?: (mode: string) => void | Promise<void>
  enterPlanMode?: () => void | Promise<void>
  readPlanFile?: () => Promise<{ path: string; content: string | null }>
  openPlanFile?: () => Promise<{ message: string }>
  submitQuery?: (input: string) => Promise<void>
  openProviderPanel?: () => void
}

export type CommandResult =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'message'; text: string }
