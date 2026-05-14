import type { TokenUsage } from '../harness/types.js'
import type { Config } from '../config/service.js'

export type SystemMessageVariant = 'info' | 'error' | 'warning' | 'success'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'

export interface DisplayMessage {
  id: string
  role: MessageRole
  content?: string
  createdAt: string

  // Tool message fields
  toolName?: string
  toolInput?: unknown
  toolOk?: boolean
  toolOutput?: string

  // Streaming state
  isStreaming?: boolean

  // System message variant
  variant?: SystemMessageVariant

  // Usage tracking
  usage?: TokenUsage

  // Pricing
  pricing?: Config['models'][string]['pricing']
}
