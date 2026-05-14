export type SystemMessageVariant = 'info' | 'error' | 'warning' | 'success'

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool_use'
  content?: string
  timestamp: number
  isStreaming?: boolean
  variant?: SystemMessageVariant
  toolUse?: any
  toolResult?: any
}
