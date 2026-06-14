import type { ZodTypeAny } from 'zod/v3'
import type { CacheBreakResult, CacheBreakSource } from './cacheBreakDetection.js'
import type { CacheRuntime } from './cacheControl.js'
import type { JsonSchema, ToolValidationResult } from './toolValidation.js'
import type { PermissionMode } from './permissions.js'
import type { SessionMetricInput } from './metrics.js'

export type RiskLevel = 'safe' | 'confirm' | 'dangerous'

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
  data?: string
}

export type ModelStreamEvent =
  | { type: 'message_start' }
  | { type: 'thinking_start'; index?: number; redacted?: boolean }
  | { type: 'thinking_delta'; index?: number; thinking: string }
  | { type: 'thinking_signature'; index?: number; signature: string }
  | { type: 'thinking_stop'; index?: number }
  | { type: 'redacted_thinking'; index?: number }
  | { type: 'text_delta'; index?: number; text: string }
  | { type: 'tool_input_delta'; index?: number; partialJson: string }
  | { type: 'message_stop' }
  | { type: 'idle_warning'; idleMs: number }

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
  display?: ToolResultDisplay
  _tokens?: number
  errorCode?: ToolErrorCode
  errorDetails?: unknown
  createdAt: string
  turnId?: string
  /**
   * Pre-mapped API result block. When a tool defines mapToolResultToToolResultBlockParam,
   * the ToolRunner calls it after execute() and caches the result here.
   * The Anthropic payload builder uses this instead of the plain-text content
   * when present, enabling tool_reference blocks for ToolSearch.
   */
  apiResultBlock?: ToolResultBlockParam
}

export type ToolProgressPhase = 'started' | 'finished'

export interface ToolProgressEvent {
  call: ToolCall
  phase: ToolProgressPhase
  source?: {
    type: 'subagent'
    agentType: string
    agentId?: string
  }
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
  postCompactRestore?: 'pending' | 'consumed'
  createdAt: string
  turnId?: string
  /** Tool names discovered via ToolSearch before compaction — survives compaction. */
  preCompactDiscoveredTools?: string[]
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

export interface ToolUseSummaryRecord {
  id: string
  type: 'tool_use_summary'
  summary: string
  toolUseIds: string[]
  createdAt: string
  turnId?: string
  model?: string
}

export interface AtMentionFileContext {
  path: string
  displayPath: string
  lineStart: number
  lineEnd: number
  truncated: boolean
}

export interface AtMentionContextRecord {
  id: string
  type: 'at_mention_context'
  userMessageId: string
  files: AtMentionFileContext[]
  content: string
  createdAt: string
  turnId?: string
}

export interface SubagentTranscriptRecord {
  id: string
  type: 'subagent_transcript'
  agentId: string
  subagentType: string
  parentToolUseId?: string
  transcriptPath?: string
  status?: SubagentTaskStatus
  stopReason?: string
  truncated?: boolean
  summary?: string
  recordCount?: number
  messageCount?: number
  toolUseCount?: number
  toolResultCount?: number
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  criticalFiles?: string[]
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
  // Intentionally empty when persisted in the parent session; full transcript
  // records live in the sidechain transcript file when transcriptPath is set.
  records?: SessionRecord[]
  usage: TokenUsage
  createdAt: string
  turnId?: string
}

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface SubagentTaskRecord {
  id: string
  type: 'subagent_task'
  agentId: string
  subagentType: string
  status: SubagentTaskStatus
  description: string
  task: string
  name?: string
  parentToolUseId?: string
  transcriptPath?: string
  summary?: string
  error?: string
  usage?: TokenUsage
  toolUseCount?: number
  durationMs?: number
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  criticalFiles?: string[]
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
  createdAt: string
  turnId?: string
}

export interface PlanModeRequestRecord {
  id: string
  type: 'plan_mode_request'
  kind: 'enter' | 'exit' | 'subagent_exit'
  submittedFromSessionId: string
  planContent?: string
  createdAt: string
  turnId?: string
}

export interface PlanModeOutcomeRecord {
  id: string
  type: 'plan_mode_outcome'
  kind: 'enter_approved' | 'enter_rejected' | 'exit_approved' | 'exit_rejected'
  requestId: string
  detail?: string
  createdAt: string
  turnId?: string
}

export interface TurnInterruptionRecord {
  id: string
  type: 'turn_interruption'
  userMessageId: string
  prompt: string
  remainingTasks: TaskItem[]
  recoverable: boolean
  consumedAt?: string
  createdAt: string
  turnId?: string
}

export type SessionRecord =
  | ({ type: 'message' } & ChatMessage)
  | AtMentionContextRecord
  | ToolUseRecord
  | ToolResultRecord
  | ToolApprovalRecord
  | CompactBoundaryRecord
  | CompactAttemptFailedRecord
  | ToolUseSummaryRecord
  | SubagentTranscriptRecord
  | SubagentTaskRecord
  | PlanModeRequestRecord
  | PlanModeOutcomeRecord
  | TurnInterruptionRecord

export interface TaskItem {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  subject: string
  description: string
  activeForm?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

export interface PlanModeBridge {
  parentSessionId: string
  parentAppendRecord(record: SessionRecord): Promise<void>
  activePlanFilePath?: string
}

export interface AskUserQuestionBridge {
  ask(input: AskUserQuestionRequest): Promise<AskUserQuestionResult>
}

export interface AskUserQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]
}

export type AskUserQuestionAnswers = Record<string, string>
export type AskUserQuestionAnnotations = Record<string, {
  preview?: string
  notes?: string
}>

export type AskUserQuestionResult =
  | { kind: 'answers'; answers: AskUserQuestionAnswers; annotations?: AskUserQuestionAnnotations }
  | { kind: 'rejected'; feedback?: string }

export interface ToolContext {
  cwd: string
  sessionId: string
  readFiles: Set<string>
  readFileState?: Map<string, ReadFileState>
  invokedSkills?: Map<string, { content: string; timestamp: number }>
  taskState?: Map<string, TaskItem>
  abortSignal?: AbortSignal
  appendRecord?(record: SessionRecord): Promise<void>
  appendMetric?(metric: SessionMetricInput): Promise<void>
  currentToolUseId?: string
  currentTurnId?: string
  getPermissionMode?(): PermissionMode
  setPermissionMode?(mode: PermissionMode): void
  exitPlanMode?(): PermissionMode
  planModeBridge?: PlanModeBridge
  askUserQuestionBridge?: AskUserQuestionBridge
  /** Active provider name ('anthropic' | 'openai') — used by ToolSearchTool to format results. */
  providerName?: string
  /** Full unfiltered tool list for ToolSearchTool scoring. */
  _allTools?: Tool[]
  /** Tool names already discovered via ToolSearch — survives compaction. */
  discoveredToolNames?: Set<string>
  /** Tool names discovered AFTER the last compaction — these still have tool_reference blocks in history. */
  _postCompactDiscoveredNames?: Set<string>
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
  metadata?: ToolResultMetadata
}

/**
 * API-level tool_result block parameter.
 * Most tools use {type, tool_use_id, content: string}.
 * ToolSearch overrides to emit tool_reference content blocks.
 */
export interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'tool_reference'; tool_name: string } | { type: 'text'; text: string }>
  is_error?: boolean
}

export interface ToolResultMetadata extends Record<string, unknown> {
  display?: ToolResultDisplay
}

export interface ToolResultDisplay {
  summary: string
  detail?: string
  taskSnapshot?: TaskDisplaySnapshot
}

export interface TaskDisplaySnapshot {
  tasks: TaskDisplayItem[]
  counts: TaskDisplayCounts
  activeTaskId?: string
}

export interface TaskDisplayItem {
  id: string
  status: TaskItem['status']
  subject: string
  description: string
  activeForm?: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
}

export interface TaskDisplayCounts {
  total: number
  remaining: number
  pending: number
  inProgress: number
  completed: number
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
  /**
   * Maximum persisted tool result content size. This is applied once when the
   * tool result is recorded so later request preparation sees stable bytes.
   */
  maxResultSizeChars?: number
  /**
   * True only for tools that can run alongside other safe tools without
   * mutating project files or shared write-tracking state.
   */
  isConcurrencySafe?: boolean
  /**
   * Optional input-sensitive concurrency check for tools whose safety depends
   * on the requested mode or subcommand.
   */
  isConcurrencySafeInput?(input: unknown): boolean
  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Should be 3-10 words describing what the tool does (e.g. "search file contents with regex").
   */
  searchHint?: string
  /**
   * When true, this tool is deferred and requires ToolSearch to load its schema
   * before it can be called. Deferred tools are announced by name only in the
   * system prompt; the model must use ToolSearch to discover their parameters.
   */
  shouldDefer?: boolean
  /**
   * When true, this tool is never deferred even if shouldDefer or isMcp is true.
   * Use for tools that must be available from the first turn.
   */
  alwaysLoad?: boolean
  /**
   * True for MCP-provided tools. MCP tools are deferred by default when
   * tool search is enabled, unless alwaysLoad is set.
   */
  isMcp?: boolean
  /**
   * User-facing name for TUI display. This mirrors Claude Code's tool-owned
   * display hooks without coupling core tools to React/Ink rendering.
   */
  userFacingName?(input: unknown): string
  /**
   * Short input summary shown in the TUI header, usually inside parentheses.
   */
  getToolUseSummary?(input: unknown): string | null | undefined
  /**
   * Present-tense activity description used by spinners/progress summaries.
   */
  getActivityDescription?(input: unknown): string | null | undefined
  /**
   * Whether the TUI should render the persisted result body under the tool use.
   */
  shouldDisplayResult?(input: unknown, result: string): boolean
  /**
   * Render-time customized one-line summary for the collapsed TUI view.
   * Runs in the React render path (not at tool execution), receives the full
   * persisted result string, and returns null to defer to display.summary.
   * Tools that already populate metadata.display.summary typically don't need
   * this hook — it's meant for tools whose result content needs parsing to
   * produce a human-readable line (e.g. Bash line counts, agent stats).
   */
  renderToolResultSummary?(input: unknown, result: string, ok: boolean): string | null
  /**
   * Convert the tool's execute() result into the API-level tool_result block.
   * Most tools return a string content; ToolSearch overrides this to emit
   * tool_reference content blocks for Anthropic's dynamic tool loading.
   * When not defined, the default behavior wraps result.content as plain text.
   */
  mapToolResultToToolResultBlockParam?(result: unknown, toolUseID: string): ToolResultBlockParam
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
  stopReason?: string
  truncated?: boolean
  segments?: string[]
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
  /** Pre-mapped API block (e.g. tool_reference for ToolSearch). */
  apiResultBlock?: ToolResultBlockParam
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
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  retry?: { maxRetries?: number; signal?: AbortSignal; callerKind?: 'interactive' | 'background'; persistent?: boolean }
  cacheSource: CacheBreakSource
  cacheRuntime?: CacheRuntime
  /** When true, the Anthropic payload builder adds defer_loading and the tool-reference beta header. */
  hasDeferredTools?: boolean
  /** All deferred tool names from the FULL (unfiltered) tool list. Used for <available-deferred-tools>. */
  allDeferredToolNames?: Set<string>
  /** Tool names discovered after the last compaction — only these should have defer_loading. */
  postCompactDiscoveredNames?: Set<string>
  onTextDelta?: (delta: string) => void
  onStreamEvent?: (event: ModelStreamEvent) => void
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
