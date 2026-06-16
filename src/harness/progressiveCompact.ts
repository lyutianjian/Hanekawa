import {
  countSessionRecordsTokens,
  countSessionRecordTokens,
  getMicroCompactThreshold,
  getSnipThreshold,
  TIME_BASED_MC_GAP_THRESHOLD_MINUTES,
  TIME_BASED_MC_KEEP_RECENT,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { CacheEditManager } from './cacheEditManager.js'
import type { SessionRecord, ToolResultRecord } from './types.js'
import { compactToolResult, getRecordsAfterLastCompact } from './requestPrep.js'

const RECENT_TOOL_RESULTS_TO_KEEP = 10

export interface ProgressiveCompactInput {
  records: SessionRecord[]
  contextManagement?: Partial<ContextManagementConfig>
  system?: string
  model?: string
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

interface ConversationSegment {
  records: SessionRecord[]
  startsWithUser: boolean
}

export function applyProgressiveCompaction(input: ProgressiveCompactInput): ProgressiveCompactResult {
  let records = input.records
  let tokenCount = estimateCurrentTokens(input)
  let microCompacted = false
  let snipped = false
  let cacheEditsPending: boolean | undefined = undefined

  // Stage 0: Time-based micro-compact. When the gap since the last assistant
  // message exceeds the threshold, the server prompt cache has expired and the
  // full prefix will be rewritten anyway — clearing old tool results is free.
  const timeBased = applyTimeBasedMicrocompact(records, input.now)
  if (timeBased.changed) {
    records = timeBased.records
    tokenCount = estimateCurrentTokens({ ...input, records })
    microCompacted = true
  }

  if (tokenCount >= getMicroCompactThreshold(input.contextManagement, input.model)) {
    if (input.cacheEditManager) {
      // Cache-aware path: register tool results for API-level deletion
      const candidates = getToolResultCandidates(records)
      for (const candidate of candidates) {
        input.cacheEditManager.registerToolResult(
          candidate.index,
          candidate.record.toolUseId,
          candidate.record.tool,
          candidate.tokens,
        )
      }
      input.cacheEditManager.produceCacheEdits()
      cacheEditsPending = true
      // Do NOT mutate records — the API will handle deletion
    } else {
      // Legacy path: mutate records locally
      const micro = microCompactToolResults(records, getMicroCompactThreshold(input.contextManagement, input.model), tokenCount)
      records = micro.records
      microCompacted = micro.compacted
      tokenCount = micro.tokenCount
    }
  }

  if (tokenCount >= getSnipThreshold(input.contextManagement, input.model)) {
    const snip = snipConversation(records, input.contextManagement, input.system, tokenCount)
    records = snip.records
    snipped = snip.snipped
    tokenCount = snip.tokenCount
  }

  return {
    records,
    tokenCount,
    microCompacted,
    snipped,
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
 * expired, so the full prefix will be rewritten regardless — clearing old
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

function microCompactToolResults(
  records: SessionRecord[],
  targetTokens: number,
  baselineTokens: number,
): { records: SessionRecord[]; tokenCount: number; compacted: boolean } {
  const candidates = getToolResultCandidates(records)
  const protectedIds = new Set(
    candidates
      .slice(-RECENT_TOOL_RESULTS_TO_KEEP)
      .map((candidate) => candidate.record.id),
  )
  let tokenCount = baselineTokens
  if (tokenCount < targetTokens) return { records, tokenCount, compacted: false }

  const compacted = new Map<number, ToolResultRecord>()
  for (const candidate of candidates) {
    if (protectedIds.has(candidate.record.id)) continue
    const nextRecord = compactToolResult(candidate.record, candidate.tokens)
    const nextTokens = countSessionRecordTokens(nextRecord)
    if (nextTokens >= candidate.tokens) continue

    compacted.set(candidate.index, nextRecord)
    tokenCount += nextTokens - candidate.tokens
    if (tokenCount < targetTokens) break
  }

  if (compacted.size === 0) return { records, tokenCount, compacted: false }

  return {
    records: records.map((record, index) => compacted.get(index) ?? record),
    tokenCount,
    compacted: true,
  }
}

function snipConversation(
  records: SessionRecord[],
  contextManagement: Partial<ContextManagementConfig> = {},
  system?: string,
  inputTokenCount?: number,
): { records: SessionRecord[]; tokenCount: number; snipped: boolean } {
  const headTurns = Math.max(0, contextManagement.snipHeadTurns ?? 3)
  const tailTurns = Math.max(1, contextManagement.snipTailTurns ?? 12)
  const maxTurns = Math.max(headTurns + tailTurns + 1, contextManagement.snipMaxTurns ?? 32)
  const segments = splitIntoConversationSegments(records)
  const turnSegments = segments.filter((segment) => segment.startsWithUser)

  if (turnSegments.length <= maxTurns || turnSegments.length <= headTurns + tailTurns) {
    return {
      records,
      // Use the input token count if available to avoid recalculating,
      // which could differ from the estimate used to decide whether snipping was needed.
      tokenCount: inputTokenCount ?? countSessionRecordsTokens(getRecordsAfterLastCompact(records), system),
      snipped: false,
    }
  }

  let userTurnsSeen = 0
  const kept: SessionRecord[] = []
  const preservedBoundaries: SessionRecord[] = []
  let removedRecords = 0
  let removedTurns = 0

  for (const segment of segments) {
    if (!segment.startsWithUser) {
      kept.push(...segment.records)
      continue
    }

    const keepHead = userTurnsSeen < headTurns
    const keepTail = userTurnsSeen >= turnSegments.length - tailTurns
    if (keepHead || keepTail) {
      kept.push(...segment.records)
    } else {
      // Preserve compact_boundary records from removed turns so that
      // getRecordsAfterLastCompact can still locate the last boundary.
      for (const record of segment.records) {
        if (record.type === 'compact_boundary') {
          preservedBoundaries.push(record)
        }
      }
      removedRecords += segment.records.length
      removedTurns += 1
    }
    userTurnsSeen += 1
  }

  if (removedRecords === 0) {
    return {
      records,
      tokenCount: countSessionRecordsTokens(getRecordsAfterLastCompact(records), system),
      snipped: false,
    }
  }

  const insertAt = insertionIndexAfterHeadTurns(kept, headTurns)
  const snipRecord: SessionRecord = {
    type: 'message',
    id: 'meta:snip-middle',
    role: 'user',
    content: `[conversation snipped: ${removedTurns} middle turns / ${removedRecords} records omitted from this request]`,
    createdAt: new Date().toISOString(),
  }
  const snippedRecords = [
    ...kept.slice(0, insertAt),
    ...preservedBoundaries,
    snipRecord,
    ...kept.slice(insertAt),
  ]

  return {
    records: snippedRecords,
    tokenCount: countSessionRecordsTokens(getRecordsAfterLastCompact(snippedRecords), system),
    snipped: true,
  }
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

function splitIntoConversationSegments(records: SessionRecord[]): ConversationSegment[] {
  const segments: ConversationSegment[] = []
  let current: SessionRecord[] = []
  let currentStartsWithUser = false

  for (const record of records) {
    if (record.type === 'message' && record.role === 'user') {
      if (current.length > 0) {
        segments.push({ records: current, startsWithUser: currentStartsWithUser })
      }
      current = [record]
      currentStartsWithUser = true
      continue
    }
    current.push(record)
  }

  if (current.length > 0) {
    segments.push({ records: current, startsWithUser: currentStartsWithUser })
  }
  return segments
}

function insertionIndexAfterHeadTurns(records: SessionRecord[], headTurns: number): number {
  if (headTurns <= 0) return 0

  let seen = 0
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record?.type === 'message' && record.role === 'user') {
      seen += 1
      if (seen > headTurns) return index
    }
  }
  return records.length
}
