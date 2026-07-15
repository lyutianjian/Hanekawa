import {
  countSessionRecordsTokens,
  countSessionRecordTokens,
  getMicroCompactThreshold,
  TIME_BASED_MC_GAP_THRESHOLD_MINUTES,
  TIME_BASED_MC_KEEP_RECENT,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { CacheEditManager } from './cacheEditManager.js'
import type { SessionRecord, ToolResultRecord } from './types.js'
import { getRecordsAfterLastCompact } from './requestPrep.js'

export interface ProgressiveCompactInput {
  records: SessionRecord[]
  contextManagement?: Partial<ContextManagementConfig>
  system?: string
  lastResponseTokenCount?: number
  lastResponseRecordId?: string
  lastResponseRecordCount?: number
  now?: Date
  cacheEditManager?: CacheEditManager
}

export interface ProgressiveCompactResult {
  records: SessionRecord[]
  tokenCount: number
  microCompacted: boolean
  snipped: boolean
  cacheEditsPending?: boolean
}

interface ToolResultCandidate {
  record: ToolResultRecord
  tokens: number
  index: number
}

export function applyProgressiveCompaction(input: ProgressiveCompactInput): ProgressiveCompactResult {
  let records = input.records
  let tokenCount = estimateCurrentTokens(input)
  let microCompacted = false
  let cacheEditsPending: boolean | undefined = undefined

  // Stage 0: Time-based micro-compact. When the gap since the last assistant
  // message exceeds the threshold, the server prompt cache has expired and the
  // full prefix will be rewritten anyway; clearing old tool results is free.
  const timeBased = applyTimeBasedMicrocompact(records, input.now)
  if (timeBased.changed) {
    records = timeBased.records
    tokenCount = estimateCurrentTokens({ ...input, records })
    microCompacted = true
  }

  if (tokenCount >= getMicroCompactThreshold(input.contextManagement) && input.cacheEditManager) {
    // Cache-aware path: register tool results for API-level deletion.
    // Do not mutate records locally; providers without cache_edits skip
    // ratio-based microcompact to preserve prompt-cache prefix stability.
    const candidates = getToolResultCandidates(records)
    for (const candidate of candidates) {
      input.cacheEditManager.registerToolResult(
        candidate.index,
        candidate.record.toolUseId,
        candidate.record.tool,
        candidate.tokens,
      )
    }
    cacheEditsPending = Boolean(input.cacheEditManager.produceCacheEdits())
    // Do not mutate records locally; the API handles deletion.
  }

  return {
    records,
    tokenCount,
    microCompacted,
    snipped: false,
    cacheEditsPending,
  }
}

export function estimateCurrentTokens(input: ProgressiveCompactInput): number {
  if (input.lastResponseTokenCount === undefined) {
    return countSessionRecordsTokens(getRecordsAfterLastCompact(input.records), input.system)
  }

  const pendingTokens = countPendingRecordTokens(
    input.records,
    input.lastResponseRecordId,
    input.lastResponseRecordCount,
  )
  if (pendingTokens === undefined) {
    return countSessionRecordsTokens(getRecordsAfterLastCompact(input.records), input.system)
  }
  return input.lastResponseTokenCount + pendingTokens
}

/**
 * Time-based micro-compact: when the gap since the last assistant message
 * exceeds the configured threshold, content-clear all but the most recent N
 * compactable tool results. The server prompt cache has almost certainly
 * expired, so the full prefix will be rewritten regardless; clearing old
 * tool results before the request shrinks what gets rewritten.
 *
 * Returns { changed: false } when the trigger doesn't fire.
 */
function applyTimeBasedMicrocompact(
  records: SessionRecord[],
  now?: Date,
): { records: SessionRecord[]; changed: boolean } {
  // Only fire when the caller explicitly provides a timestamp (loop.ts does).
  // Without an explicit `now`, tests and internal callers are not affected.
  if (!now) {
    return { records, changed: false }
  }
  const currentTime = now

  // Find the last assistant message timestamp
  let lastAssistantTime: string | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record?.type === 'message' && record.role === 'assistant') {
      lastAssistantTime = record.createdAt
      break
    }
  }
  if (!lastAssistantTime) {
    return { records, changed: false }
  }

  const gapMs = currentTime.getTime() - new Date(lastAssistantTime).getTime()
  const gapMinutes = gapMs / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < TIME_BASED_MC_GAP_THRESHOLD_MINUTES) {
    return { records, changed: false }
  }

  // Collect tool result IDs in encounter order
  const toolResultIds: string[] = []
  for (const record of records) {
    if (record.type === 'tool_result') {
      toolResultIds.push(record.id)
    }
  }

  // Floor at 1: clearing ALL results leaves the model with zero working context
  const keepRecent = Math.max(1, TIME_BASED_MC_KEEP_RECENT)
  const keepSet = new Set(toolResultIds.slice(-keepRecent))
  const clearIds = new Set(toolResultIds.filter((id) => !keepSet.has(id)))

  if (clearIds.size === 0) {
    return { records, changed: false }
  }

  let changed = false
  const updatedRecords = records.map((record) => {
    if (
      record.type === 'tool_result'
      && clearIds.has(record.id)
      && record.content !== '[Old tool result content cleared]'
    ) {
      changed = true
      return { ...record, content: '[Old tool result content cleared]' }
    }
    return record
  })

  return { records: updatedRecords, changed }
}

function getToolResultCandidates(records: SessionRecord[]): ToolResultCandidate[] {
  return records
    .map((record, index): ToolResultCandidate | undefined => {
      if (record.type !== 'tool_result') return undefined
      return {
        record,
        tokens: countSessionRecordTokens(record),
        index,
      }
    })
    .filter((candidate): candidate is ToolResultCandidate => candidate !== undefined)
}

function countPendingRecordTokens(
  records: SessionRecord[],
  lastResponseRecordId?: string,
  lastResponseRecordCount?: number,
): number | undefined {
  if (lastResponseRecordId === undefined && lastResponseRecordCount === undefined) return 0

  const boundaryIndex = findLastResponseBoundaryIndex(records, lastResponseRecordId, lastResponseRecordCount)
  if (boundaryIndex === undefined) return undefined

  const pendingRecords = records.slice(boundaryIndex + 1)
  let skippedResponseMessage = false
  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordsTokens([record])
  }, 0)
}

function findLastResponseBoundaryIndex(
  records: SessionRecord[],
  lastResponseRecordId?: string,
  lastResponseRecordCount?: number,
): number | undefined {
  if (lastResponseRecordId) {
    const index = records.findIndex((record) => record.id === lastResponseRecordId)
    return index >= 0 ? index : undefined
  }

  if (lastResponseRecordCount === undefined) return undefined
  return lastResponseRecordCount - 1
}
