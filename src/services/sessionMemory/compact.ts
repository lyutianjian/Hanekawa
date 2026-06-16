/**
 * Session memory compaction integration.
 *
 * When auto-compact triggers, this module tries to use the session memory
 * as the compaction summary instead of calling the LLM. This makes
 * compaction instant (no API call, no latency).
 *
 * Falls back to null if session memory is not available or would exceed
 * the auto-compact threshold.
 */

import { randomUUID } from 'node:crypto'
import type {
  SessionRecord,
  CompactBoundaryRecord,
  TokenUsage,
} from '../../harness/types.js'
import { EMPTY_TOKEN_USAGE } from '../../harness/usage.js'
import {
  countTextTokens,
  countSessionRecordTokens,
} from '../../prompts/budget.js'
import {
  getSessionMemory,
  waitForExtraction,
  setLastSummarizedRecordId,
} from './service.js'
import {
  truncateSessionMemory,
  isSessionMemoryEmpty,
} from './prompts.js'
import type {
  SessionMemoryConfig,
  SessionMemoryCompactParams,
  SessionMemoryCompactResult,
} from './types.js'
import { DEFAULT_SESSION_MEMORY_CONFIG } from './types.js'

/**
 * Try to compact using session memory instead of LLM summarization.
 *
 * Returns a SessionMemoryCompactResult on success, or null if:
 * - Session memory is not available or empty
 * - Post-compact token count would exceed the auto-compact threshold
 * - Any error occurs during processing
 */
export async function trySessionMemoryCompaction(
  params: SessionMemoryCompactParams,
): Promise<SessionMemoryCompactResult | null> {
  const config = { ...DEFAULT_SESSION_MEMORY_CONFIG, ...params.config }
  if (!config.enabled) return null

  // Wait for any in-progress extraction (with timeout)
  await waitForExtraction(params.sessionId, 5_000)

  // Load session memory from disk
  const memory = await getSessionMemory(params.sessionId)
  if (!memory || isSessionMemoryEmpty(memory.content)) return null

  // Find the last summarized record index
  const lastSummarizedIndex = memory.lastSummarizedRecordId
    ? params.records.findIndex((r) => r.id === memory.lastSummarizedRecordId)
    : -1

  // Calculate which records to keep as recent context
  const keepIndex = calculateRecordsToKeepIndex(
    params.records,
    lastSummarizedIndex >= 0 ? lastSummarizedIndex : params.records.length,
    config,
  )

  const recordsToKeep = params.records.slice(keepIndex)

  // Check if post-compact size would exceed threshold
  const summaryTokens = countTextTokens(memory.content)
  const keptTokens = recordsToKeep.reduce(
    (sum, r) => sum + countSessionRecordTokens(r),
    0,
  )
  const postTokens = summaryTokens + keptTokens

  if (params.autoCompactThreshold !== undefined && postTokens >= params.autoCompactThreshold) {
    // Post-compact would still exceed threshold — fall back to LLM compaction
    return null
  }

  // Build compact boundary record
  const preTokens = params.records.reduce(
    (sum, r) => sum + countSessionRecordTokens(r),
    0,
  )

  const { truncatedContent, wasTruncated } = truncateSessionMemory(
    memory.content,
    config.maxMemoryTokens,
  )

  let summaryContent = truncatedContent
  if (wasTruncated) {
    summaryContent += '\n\n[Some session memory sections were truncated for length.]'
  }

  const boundary: CompactBoundaryRecord = {
    id: randomUUID(),
    type: 'compact_boundary',
    summary: summaryContent,
    preTokens,
    postCompactRestore: 'pending',
    ...(params.discoveredToolNames && params.discoveredToolNames.size > 0
      ? { preCompactDiscoveredTools: [...params.discoveredToolNames] }
      : {}),
    createdAt: new Date().toISOString(),
  }

  // Reset last summarized record ID since compaction prunes records
  setLastSummarizedRecordId(params.sessionId, undefined)

  return {
    boundary,
    usage: { ...EMPTY_TOKEN_USAGE }, // No LLM call — zero cost
    preTokens,
    postTokens,
  }
}

/**
 * Calculate the starting index for records to keep after compaction.
 *
 * Starts from lastSummarizedIndex, then expands backwards to meet minimums:
 * - At least config.minTokens tokens
 * - At least config.minTextMessages messages with text content
 *
 * Stops expanding if config.maxTokens is reached.
 * Also adjusts to avoid splitting tool_use/tool_result pairs.
 */
export function calculateRecordsToKeepIndex(
  records: SessionRecord[],
  lastSummarizedIndex: number,
  config: SessionMemoryConfig = DEFAULT_SESSION_MEMORY_CONFIG,
): number {
  if (records.length === 0) return 0

  // Start from the record after lastSummarizedIndex
  let startIndex = lastSummarizedIndex >= 0
    ? Math.min(lastSummarizedIndex + 1, records.length)
    : records.length

  // Calculate current tokens and text message count from startIndex to end
  let totalTokens = 0
  let textMessageCount = 0
  for (let i = startIndex; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    totalTokens += countSessionRecordTokens(record)
    if (record.type === 'message' && record.role !== 'system' && typeof record.content === 'string' && record.content.length > 0) {
      textMessageCount++
    }
  }

  // Check if we already hit the max cap
  if (totalTokens >= config.maxTokens) {
    return adjustIndexForToolPairs(records, startIndex)
  }

  // Check if we already meet both minimums
  if (totalTokens >= config.minTokens && textMessageCount >= config.minTextMessages) {
    return adjustIndexForToolPairs(records, startIndex)
  }

  // Expand backwards until we meet both minimums or hit max cap
  for (let i = startIndex - 1; i >= 0; i--) {
    const record = records[i]
    if (!record) break

    const recordTokens = countSessionRecordTokens(record)
    totalTokens += recordTokens
    if (record.type === 'message' && record.role !== 'system' && typeof record.content === 'string' && record.content.length > 0) {
      textMessageCount++
    }
    startIndex = i

    // Stop if we hit the max cap
    if (totalTokens >= config.maxTokens) break

    // Stop if we meet both minimums
    if (totalTokens >= config.minTokens && textMessageCount >= config.minTextMessages) break
  }

  return adjustIndexForToolPairs(records, startIndex)
}

/**
 * Adjust the start index to ensure we don't split tool_use/tool_result pairs.
 *
 * If any kept record is a tool_result, we must also keep the preceding
 * tool_use record. This prevents orphaned tool_results in the API request.
 */
function adjustIndexForToolPairs(
  records: SessionRecord[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= records.length) return startIndex

  // Collect tool_use_ids from tool_result records in the kept range
  const toolResultUseIds = new Set<string>()
  for (let i = startIndex; i < records.length; i++) {
    const record = records[i]
    if (record?.type === 'tool_result') {
      toolResultUseIds.add(record.toolUseId)
    }
  }

  if (toolResultUseIds.size === 0) return startIndex

  // Find the earliest tool_use record that matches
  let adjustedIndex = startIndex
  for (let i = startIndex - 1; i >= 0; i--) {
    const record = records[i]
    if (record?.type === 'tool_use' && toolResultUseIds.has(record.id)) {
      adjustedIndex = i
      toolResultUseIds.delete(record.id)
    }
    if (toolResultUseIds.size === 0) break
  }

  return adjustedIndex
}
