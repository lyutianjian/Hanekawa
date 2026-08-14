/**
 * Session memory types.
 *
 * Session memory is an ongoing extraction of key conversation facts
 * (decisions, file paths, constraints, open tasks) that can be used
 * as a compaction summary without calling the LLM again.
 */

import type { TokenUsage } from '../../harness/types.js'
import type { CompactBoundaryRecord } from '../../harness/types.js'

/** Persisted session memory state (written to disk). */
export interface SessionMemoryState {
  /** Extracted memory text — the actual summary content. */
  content: string
  /** ID of the last record incorporated into the memory. */
  lastSummarizedRecordId: string
  /** ISO timestamp of last successful extraction. */
  lastExtractedAt: string
  /** Estimated token count of content. */
  tokenCount: number
}

/** Configuration for session memory behavior. */
export interface SessionMemoryConfig {
  /** Master switch — when false, session memory is disabled. */
  enabled: boolean
  /** Minimum tokens to preserve as recent context after compaction. */
  minTokens: number
  /** Minimum number of messages with text content to keep. */
  minTextMessages: number
  /** Maximum tokens to preserve as recent context (hard cap). */
  maxTokens: number
  /** Maximum token count for the session memory content itself. */
  maxMemoryTokens: number
  /** Minimum number of new records required before extraction runs. */
  minRecordsForExtraction: number
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  enabled: process.env.MYAGENT_SESSION_MEMORY === '1',
  minTokens: 10_000,
  minTextMessages: 5,
  maxTokens: 40_000,
  maxMemoryTokens: 8_000,
  minRecordsForExtraction: 3,
}

/** Result of a session memory extraction call. */
export interface ExtractionResult {
  content: string
  usage: TokenUsage
  recordCount: number
}

/** Parameters for session memory compaction attempt. */
export interface SessionMemoryCompactParams {
  records: import('../../harness/types.js').SessionRecord[]
  provider: import('../../harness/types.js').ModelProvider
  model: string
  system?: string
  sessionId: string
  /** Project root the memory file lives under. Defaults to `process.cwd()`. */
  cwd?: string
  /** Auto-compact threshold — if post-compact tokens exceed this, skip SM compact. */
  autoCompactThreshold?: number
  /** Tool names discovered via ToolSearch — preserved in compact boundary. */
  discoveredToolNames?: Set<string>
  /** Runtime config overrides. */
  config?: Partial<SessionMemoryConfig>
}

/** Result of a session memory compaction attempt. */
export interface SessionMemoryCompactResult {
  boundary: CompactBoundaryRecord
  usage: TokenUsage
  preTokens: number
  postTokens: number
}
