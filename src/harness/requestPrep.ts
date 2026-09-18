import {
  countSessionRecordTokens,
  getEffectiveContextWindowSize,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { ImageTokenStrategy } from '../media/imageTokens.js'
import type { SessionRecord, ToolResultRecord, TokenUsage } from './types.js'
import { repairToolResultPairing } from '../sessions/invariants.js'
import { snipLargeToolResults } from './compact.js'
import { projectRecordImagesToText } from './turnImages.js'
import { promptTokens } from './usage.js'

const TOOL_RESULTS_CONTEXT_RATIO = 0.5
const TOOL_RESULTS_TOKEN_BUDGET_CAP = 200_000
const RECENT_TOOL_RESULTS_TO_KEEP = 10
const RECENT_ASSISTANT_THINKING_TURNS_TO_KEEP = 3

export interface RequestPrepDiagnostic {
  code: 'tool_protocol_repaired'
  severity: 'info' | 'warning'
  message: string
  recordId?: string
  toolUseId?: string
  tool?: string
}

export interface PreparedRecordsResult {
  records: SessionRecord[]
  diagnostics: RequestPrepDiagnostic[]
}

export interface RequestPrepOptions {
  repairToolPairing?: boolean
  recentAssistantThinkingTurnsToKeep?: number
  /** Image-token strategy of the model serving this request (design §11.2). */
  imageTokenStrategy?: ImageTokenStrategy
}

export function requestTokenCountFromUsage(usage?: TokenUsage): number | undefined {
  if (!usage) return undefined
  // The prompt *and* the response: this estimates what the next request will
  // carry, and the assistant message just generated is part of it.
  return promptTokens(usage) + usage.outputTokens
}

export function prepareRecordsForRequest(
  records: SessionRecord[],
  contextManagement: Partial<ContextManagementConfig> = {},
  now = new Date(),
): SessionRecord[] {
  return prepareRecordsForRequestWithDiagnostics(records, contextManagement, now).records
}

export function prepareRecordsForRequestWithDiagnostics(
  records: SessionRecord[],
  contextManagement: Partial<ContextManagementConfig> = {},
  now = new Date(),
  options: RequestPrepOptions = {},
): PreparedRecordsResult {
  const requestVisibleRecords = records.filter((record) => record.type !== 'subagent_transcript')
  const recordsAfterCompact = getRecordsAfterLastCompact(requestVisibleRecords)
  // The media-count cap runs after the capability projection in the loop
  // (design §11.1: projection before budget), on the model actually serving
  // the request — see `loadPreparedRecords` and `mediaStrip.ts`.
  const thinkingStripped = stripThinkingBlocksFromAssistantMessages(
    recordsAfterCompact,
    options.recentAssistantThinkingTurnsToKeep,
  )
  const toolResultLimit = getToolResultTokenLimit(contextManagement)
  const compactedToolResultIds = selectToolResultsToCompact(
    thinkingStripped,
    toolResultLimit,
    now,
    options.imageTokenStrategy,
  )

  const budgetCompacted = thinkingStripped.map((record) => {
    if (record.type !== 'tool_result') return record
    if (!compactedToolResultIds.has(record.id)) return record
    const tokens = getToolResultTokens(record, options.imageTokenStrategy)
    return compactToolResult(record, tokens)
  })

  // Snip individual oversized tool results (hard cap per result).
  // Runs after budget compaction so already-summarized results are not re-snipped.
  const prepared = snipLargeToolResults(budgetCompacted)

  if (options.repairToolPairing === false) {
    return { records: prepared, diagnostics: [] }
  }

  return repairToolPairingForRequest(prepared)
}

export function stripThinkingBlocksFromAssistantMessages(
  records: SessionRecord[],
  recentAssistantTurnsToKeep = RECENT_ASSISTANT_THINKING_TURNS_TO_KEEP,
): SessionRecord[] {
  const protectedMessageIds = new Set<string>()
  let assistantTurnsSeen = 0

  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.type !== 'message' || record.role !== 'assistant') continue

    assistantTurnsSeen += 1
    if (assistantTurnsSeen <= recentAssistantTurnsToKeep) {
      protectedMessageIds.add(record.id)
    }
  }

  return records.map((record) => {
    if (
      record.type !== 'message'
      || record.role !== 'assistant'
      || protectedMessageIds.has(record.id)
      || !record.thinkingBlocks
    ) {
      return record
    }

    const { thinkingBlocks: _thinkingBlocks, ...rest } = record
    return rest
  })
}

export function getRecordsAfterLastCompact(records: SessionRecord[]): SessionRecord[] {
  for (let index = records.length - 1; index >= 0; index--) {
    // Keep the boundary so ContextBuilder can render its summary into the next request.
    if (records[index]?.type === 'compact_boundary') return records.slice(index)
  }
  return [...records]
}

interface ToolResultCandidate {
  record: ToolResultRecord
  tokens: number
}

function getToolResultTokenLimit(
  contextManagement: Partial<ContextManagementConfig>,
): number {
  return Math.min(
    Math.floor(getEffectiveContextWindowSize(contextManagement) * TOOL_RESULTS_CONTEXT_RATIO),
    TOOL_RESULTS_TOKEN_BUDGET_CAP,
  )
}

function selectToolResultsToCompact(
  records: SessionRecord[],
  toolResultLimit: number,
  now: Date,
  imageTokenStrategy?: ImageTokenStrategy,
): Set<string> {
  void now
  const candidates: ToolResultCandidate[] = []
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.type === 'tool_result') {
      candidates.push({
        record,
        tokens: getToolResultTokens(record, imageTokenStrategy),
      })
    }
  }

  let totalTokens = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0)
  if (totalTokens <= toolResultLimit) return new Set()

  const protectedIds = new Set(
    candidates
      .slice(0, RECENT_TOOL_RESULTS_TO_KEEP)
      .map((candidate) => candidate.record.id),
  )
  const compactedIds = new Set<string>()

  const unprotectedCandidates = candidates
    .filter((candidate) => !protectedIds.has(candidate.record.id))
    .reverse()

  for (const candidate of unprotectedCandidates) {
    totalTokens = compactCandidate(candidate, compactedIds, totalTokens, imageTokenStrategy)
    if (totalTokens <= toolResultLimit) return compactedIds
  }

  if (totalTokens > toolResultLimit) {
    for (const candidate of [...candidates].reverse()) {
      if (compactedIds.has(candidate.record.id)) continue
      totalTokens = compactCandidate(candidate, compactedIds, totalTokens, imageTokenStrategy)
      if (totalTokens <= toolResultLimit) break
    }
  }

  return compactedIds
}

function compactCandidate(
  candidate: ToolResultCandidate,
  compactedIds: Set<string>,
  totalTokens: number,
  imageTokenStrategy?: ImageTokenStrategy,
): number {
  compactedIds.add(candidate.record.id)
  return totalTokens
    - candidate.tokens
    + getToolResultTokens(compactToolResult(candidate.record, candidate.tokens), imageTokenStrategy)
}

/**
 * One source for a tool result's cost: the budget counter, which folds the
 * text `_tokens` cache together with live image-token arithmetic so a stale
 * cache can never read as the whole count.
 */
function getToolResultTokens(record: ToolResultRecord, imageTokenStrategy?: ImageTokenStrategy): number {
  return countSessionRecordTokens(record, imageTokenStrategy)
}

export function compactToolResult(record: ToolResultRecord, tokens: number): ToolResultRecord {
  // Images go with the text (design §11.3): a result whose output was removed
  // for the budget must not keep uploading the pixels that made it expensive.
  const projected = projectRecordImagesToText(record, {
    content: [
      `[summarized: ${record.tool} ${tokens} tokens]`,
      `status: ${record.ok ? 'ok' : 'error'}`,
      'The original output was removed from this request to stay within the context budget.',
    ].join('\n'),
  })
  return { ...projected, _tokens: undefined }
}

function repairToolPairingForRequest(records: SessionRecord[]): PreparedRecordsResult {
  const repaired = repairToolResultPairing(records)
  return {
    records: repaired.records,
    diagnostics: repaired.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      severity: 'warning',
    })),
  }
}
