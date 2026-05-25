import {
  countSessionRecordTokens,
  getEffectiveContextWindowSize,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { SessionRecord, ToolResultRecord, TokenUsage } from './types.js'
import { stripExcessMediaItems } from './mediaStrip.js'
import { repairToolResultPairing } from '../sessions/invariants.js'

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
}

export function requestTokenCountFromUsage(usage?: TokenUsage): number | undefined {
  if (!usage) return undefined
  return usage.inputTokens
    + usage.cacheReadInputTokens
    + usage.outputTokens
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
  const stripped = stripExcessMediaItems(recordsAfterCompact)
  const thinkingStripped = stripThinkingBlocksFromAssistantMessages(
    stripped,
    options.recentAssistantThinkingTurnsToKeep,
  )
  const toolResultLimit = getToolResultTokenLimit(contextManagement)
  const compactedToolResultIds = selectToolResultsToCompact(thinkingStripped, toolResultLimit, now)

  const prepared = thinkingStripped.map((record) => {
    if (record.type !== 'tool_result') return record
    if (!compactedToolResultIds.has(record.id)) return record
    const tokens = getToolResultTokens(record)
    return compactToolResult(record, tokens)
  })

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

function getRecordsAfterLastCompact(records: SessionRecord[]): SessionRecord[] {
  for (let index = records.length - 1; index >= 0; index--) {
    if (records[index]?.type === 'compact_boundary') return records.slice(index)
  }
  return [...records]
}

interface ToolResultCandidate {
  record: ToolResultRecord
  tokens: number
}

function getToolResultTokenLimit(contextManagement: Partial<ContextManagementConfig>): number {
  return Math.min(
    Math.floor(getEffectiveContextWindowSize(contextManagement) * TOOL_RESULTS_CONTEXT_RATIO),
    TOOL_RESULTS_TOKEN_BUDGET_CAP,
  )
}

function selectToolResultsToCompact(records: SessionRecord[], toolResultLimit: number, now: Date): Set<string> {
  void now
  const candidates: ToolResultCandidate[] = []
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.type === 'tool_result') {
      candidates.push({
        record,
        tokens: getToolResultTokens(record),
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
    totalTokens = compactCandidate(candidate, compactedIds, totalTokens)
    if (totalTokens <= toolResultLimit) return compactedIds
  }

  if (totalTokens > toolResultLimit) {
    for (const candidate of [...candidates].reverse()) {
      if (compactedIds.has(candidate.record.id)) continue
      totalTokens = compactCandidate(candidate, compactedIds, totalTokens)
      if (totalTokens <= toolResultLimit) break
    }
  }

  return compactedIds
}

function compactCandidate(candidate: ToolResultCandidate, compactedIds: Set<string>, totalTokens: number): number {
  compactedIds.add(candidate.record.id)
  return totalTokens
    - candidate.tokens
    + getToolResultTokens(compactToolResult(candidate.record, candidate.tokens))
}

function getToolResultTokens(record: ToolResultRecord): number {
  if (typeof record._tokens === 'number') return record._tokens
  const tokens = countSessionRecordTokens(record)
  record._tokens = tokens
  return tokens
}

export function compactToolResult(record: ToolResultRecord, tokens: number): ToolResultRecord {
  return {
    ...record,
    content: [
      `[summarized: ${record.tool} ${tokens} tokens]`,
      `status: ${record.ok ? 'ok' : 'error'}`,
      'The original output was removed from this request to stay within the context budget.',
    ].join('\n'),
    _tokens: undefined,
  }
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
