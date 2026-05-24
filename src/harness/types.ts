import type { ZodTypeAny } from 'zod/v3'
import type { CacheBreakResult, CacheBreakSource } from './cacheBreakDetection.js'
import type { CacheRuntime } from './cacheControl.js'
import type { JsonSchema, ToolValidationResult } from './toolValidation.js'

export type RiskLevel = 'safe' | 'confirm' | 'dangerous'

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
  data?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  turnId?: string
  model?: string
  reasoningContent?: string
  thinkingBlocks?: ThinkingBlock[]
}

export interface ToolUseRecord {
  id: string
  type: 'tool_use'
  tool: string
  input: unknown
  riskLevel: RiskLevel
  createdAt: string
  turnId?: string
}

export interface ToolResultRecord {
  id: string
  type: 'tool_result'
  toolUseId: string
  tool: string
  ok: boolean
  content: string
  _tokens?: number
  errorCode?: ToolErrorCode
  errorDetails?: unknown
  createdAt: string
  turnId?: string
}

export interface ToolApprovalRecord {
  id: string
  type: 'tool_approval'
  tool: string
  input: unknown
  approved: boolean
  riskLevel: RiskLevel
  createdAt: string
  turnId?: string
}

export interface CompactBoundaryRecord {
  id: string
  type: 'compact_boundary'
  summary: string
  preTokens: number
  createdAt: string
  turnId?: string
}

export interface CompactAttemptFailedRecord {
  id: string
  type: 'compact_attempt_failed'
  error: string
  failureCount: number
  circuitOpen: boolean
  preTokens: number
  createdAt: string
  turnId?: string
}

export type SessionRecord =
  | ({ type: 'message' } & ChatMessage)
  | ToolUseRecord
  | ToolResultRecord
  | ToolApprovalRecord
  | CompactBoundaryRecord
  | CompactAttemptFailedRecord

export interface TaskItem {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
  blockedBy: string[]
  blocks: string[]
}

export interface ToolContext {
  cwd: string
  sessionId: string
  readFiles: Set<string>
  readFileState?: Map<string, ReadFileState>
  invokedSkills?: Map<string, { content: string; timestamp: number }>
  taskState?: Map<string, TaskItem>
  abortSignal?: AbortSignal
}

export type ToolErrorCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'precondition_failed'
  | 'stale_file'
  | 'not_found'
  | 'timeout'
  | 'command_failed'
  | 'execution_failed'
  | 'aborted'

export interface ReadFileState {
  content: string
  timestamp: number
  mtimeMs: number
  ctimeMs?: number
  size: number
  dev?: number
  ino?: number
}

export interface ToolResult {
  ok: boolean
  content: string
  errorCode?: ToolErrorCode
  errorDetails?: unknown
  metadata?: Record<string, unknown>
}

export interface Tool {
  name: string
  description: string
  inputSchema: ZodTypeAny
  apiInputSchema?: JsonSchema
  validateInput?(input: unknown): ToolValidationResult
  riskLevel: RiskLevel
  isReadOnly?: boolean
  isDestructive?: boolean
  isConcurrencySafe?: boolean
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

export interface CommandContext {
  cwd: string
  writeLine(message: string): void
}

export interface Command {
  name: string
  description: string
  run(args: string[], context: CommandContext): Promise<void>
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface TokenUsage {
  inputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

export interface ModelPricing {
  cacheReadInputPerMillionTokens?: number
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  currency?: string
}

export interface AgentRunResult {
  content: string
  usage: TokenUsage
}

export interface ContextChatMessage {
  kind: 'message'
  message: ChatMessage
}

export interface ContextToolUse {
  kind: 'tool_use'
  id: string
  tool: string
  input: unknown
}

export interface ContextToolResult {
  kind: 'tool_result'
  toolUseId: string
  tool: string
  ok: boolean
  content: string
}

export type ModelContextItem = ContextChatMessage | ContextToolUse | ContextToolResult

export interface ModelRequest {
  system?: string
  systemBlocks?: string[]
  messages: ChatMessage[]
  contextItems?: ModelContextItem[]
  tools?: Tool[]
  model: string
  promptCacheRetention?: 'in_memory' | '24h'
  maxOutputTokens?: number
  previousRequestId?: string
  thinking?: { enabled: boolean; budgetTokens?: number }
  retry?: { maxRetries?: number; signal?: AbortSignal; callerKind?: 'interactive' | 'background' }
  cacheSource: CacheBreakSource
  cacheRuntime?: CacheRuntime
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  requestId?: string
  stopReason?: string
  reasoningContent?: string
  thinkingBlocks?: ThinkingBlock[]
  cacheBreak?: CacheBreakResult
}

export interface ModelProvider {
  name: string
  createMessage(request: ModelRequest): Promise<ModelResponse>
}
