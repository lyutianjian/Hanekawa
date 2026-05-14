export interface CommandDefinition {
  name: string
  description: string
  argumentHint?: string
  isEnabled?: () => boolean
  run: (args: string, context: CommandContext) => Promise<string | void>
}

export interface CommandContext {
  cwd: string
  sessionId: string
  writeLine: (msg: string) => void
  clearMessages: () => void
  getUsage?: () => { inputTokens: number; outputTokens: number; cost: number }
  getModel?: () => string
  setModel?: (model: string) => void
}

export type CommandResult =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'message'; text: string }
