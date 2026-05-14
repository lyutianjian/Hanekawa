export type MessageRole = 'user' | 'assistant' | 'system'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string }

export type ChatMessage = {
  id: string
  role: MessageRole
  content: ContentBlock[] | string
  model?: string
  timestamp?: number
  isStreaming?: boolean
  toolStatus?: 'running' | 'done' | 'error'
}
