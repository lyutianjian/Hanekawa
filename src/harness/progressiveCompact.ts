import {
  countSessionRecordsTokens,
  countSessionRecordTokens,
  getMicroCompactThreshold,
  getSnipThreshold,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { SessionRecord, ToolResultRecord } from './types.js'
import { compactToolResult, getRecordsAfterLastCompact } from './requestPrep.js'

const RECENT_TOOL_RESULTS_TO_KEEP = 10

export interface ProgressiveCompactInput {
  records: SessionRecord[]
  contextManagement?: Partial<ContextManagementConfig>
  system?: string
  lastResponseTokenCount?: number
  lastResponseRecordCount?: number
}

export interface ProgressiveCompactResult {
  records: SessionRecord[]
  tokenCount: number
  microCompacted: boolean
  snipped: boolean
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

  if (tokenCount >= getMicroCompactThreshold(input.contextManagement)) {
    const micro = microCompactToolResults(records, getMicroCompactThreshold(input.contextManagement), tokenCount)
    records = micro.records
    microCompacted = micro.compacted
    tokenCount = micro.tokenCount
  }

  if (tokenCount >= getSnipThreshold(input.contextManagement)) {
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
  }
}

export function estimateCurrentTokens(input: ProgressiveCompactInput): number {
  if (input.lastResponseTokenCount === undefined) {
    return countSessionRecordsTokens(getRecordsAfterLastCompact(input.records), input.system)
  }

  return input.lastResponseTokenCount + countPendingRecordTokens(input.records, input.lastResponseRecordCount)
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

function countPendingRecordTokens(records: SessionRecord[], lastResponseRecordCount?: number): number {
  if (lastResponseRecordCount === undefined) return 0

  const pendingRecords = records.slice(lastResponseRecordCount)
  let skippedResponseMessage = false
  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordsTokens([record])
  }, 0)
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
