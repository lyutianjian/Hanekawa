import { randomUUID } from 'node:crypto'
import type { ChatMessage, CompactBoundaryRecord, ModelProvider, SessionRecord, Tool, TokenUsage } from './types.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import {
  countTextTokens,
  countSessionRecordsTokens,
  getAutoCompactThreshold,
  type ContextManagementConfig,
} from '../prompts/budget.js'

const COMPACT_FAILURE_LIMIT = 3
const compactFailuresByKey = new Map<string, number>()
const compactRunsByKey = new Map<string, Promise<CompactCheckResult>>()

export interface CompactCheckInput {
  records: SessionRecord[]
  provider: ModelProvider
  model: string
  tools: Tool[]
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  lastResponseTokenCount?: number
  lastResponseRecordCount?: number
  promptCacheRetention?: 'in_memory' | '24h'
  turnId?: string
  circuitKey?: string
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  appendRecord(record: SessionRecord): Promise<void>
}

export interface CompactCheckResult {
  compacted: boolean
  usage: TokenUsage
  metrics?: {
    preTokens: number
    postTokens: number
    compactDurationMs: number
  }
}

export async function autoCompactIfNeeded(input: CompactCheckInput): Promise<CompactCheckResult> {
  const circuitKey = input.circuitKey ?? 'default'
  const existingRun = compactRunsByKey.get(circuitKey)
  if (existingRun) return existingRun

  const run = autoCompactIfNeededOnce(input, circuitKey)
  compactRunsByKey.set(circuitKey, run)
  try {
    return await run
  } finally {
    if (compactRunsByKey.get(circuitKey) === run) {
      compactRunsByKey.delete(circuitKey)
    }
  }
}

async function autoCompactIfNeededOnce(input: CompactCheckInput, circuitKey: string): Promise<CompactCheckResult> {
  const currentFailures = await getCompactFailureCount(input, circuitKey)
  if (currentFailures >= COMPACT_FAILURE_LIMIT) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  const compactableRecords = getRecordsAfterLastCompact(input.records)
  const tokenCount = countCurrentTokens(input, compactableRecords)
  const threshold = getAutoCompactThreshold(input.contextManagement)

  if (tokenCount < threshold) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  const recordsToCompact = selectRecordsToCompact(compactableRecords)
  if (recordsToCompact.length === 0) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  try {
    const compactStartedAt = Date.now()
    const summary = await summarizeRecords(input, recordsToCompact, tokenCount)
    await input.appendRecord({
      id: randomUUID(),
      type: 'compact_boundary',
      summary: summary.content,
      preTokens: tokenCount,
      postCompactRestore: 'pending',
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: new Date().toISOString(),
    })
    compactFailuresByKey.delete(circuitKey)
    await setCompactFailureCount(input, circuitKey, 0)

    return {
      compacted: true,
      usage: addTokenUsage({ ...EMPTY_TOKEN_USAGE }, summary.usage),
      metrics: {
        preTokens: tokenCount,
        postTokens: countTextTokens(summary.content),
        compactDurationMs: Date.now() - compactStartedAt,
      },
    }
  } catch (error) {
    const failureCount = currentFailures + 1
    await setCompactFailureCount(input, circuitKey, failureCount)
    await appendCompactFailureRecord(input, error, failureCount, tokenCount)
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }
}

export function resetAutoCompactFailureState(circuitKey?: string): void {
  if (circuitKey) {
    compactFailuresByKey.delete(circuitKey)
    compactRunsByKey.delete(circuitKey)
    return
  }
  compactFailuresByKey.clear()
  compactRunsByKey.clear()
}

function countCurrentTokens(input: CompactCheckInput, compactableRecords: SessionRecord[]): number {
  if (input.lastResponseTokenCount === undefined) {
    return countSessionRecordsTokens(compactableRecords, input.system)
  }

  return input.lastResponseTokenCount + countPendingRecordTokens(input)
}

function countPendingRecordTokens(input: CompactCheckInput): number {
  if (input.lastResponseRecordCount === undefined) return 0

  const pendingRecords = input.records.slice(input.lastResponseRecordCount)
  let skippedResponseMessage = false

  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordsTokens([record])
  }, 0)
}

async function getCompactFailureCount(input: CompactCheckInput, circuitKey: string): Promise<number> {
  if (!input.getCompactFailureCount) {
    return compactFailuresByKey.get(circuitKey) ?? 0
  }

  try {
    return await input.getCompactFailureCount()
  } catch {
    return compactFailuresByKey.get(circuitKey) ?? 0
  }
}

async function setCompactFailureCount(input: CompactCheckInput, circuitKey: string, count: number): Promise<void> {
  if (count <= 0) {
    compactFailuresByKey.delete(circuitKey)
  } else {
    compactFailuresByKey.set(circuitKey, count)
  }

  if (!input.setCompactFailureCount) return
  try {
    await input.setCompactFailureCount(count)
  } catch {
    // Persistent circuit state is best-effort; compaction must remain fail-open.
  }
}

async function appendCompactFailureRecord(
  input: CompactCheckInput,
  error: unknown,
  failureCount: number,
  tokenCount: number,
): Promise<void> {
  try {
    await input.appendRecord({
      id: randomUUID(),
      type: 'compact_attempt_failed',
      error: formatCompactError(error),
      failureCount,
      circuitOpen: failureCount >= COMPACT_FAILURE_LIMIT,
      preTokens: tokenCount,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  } catch {
    // Telemetry is best-effort; compact failure should not fail the user turn.
  }
}

function getRecordsAfterLastCompact(records: SessionRecord[]): SessionRecord[] {
  const lastCompactIndex = findLastRecordIndex(records, (record) => record.type === 'compact_boundary')
  return lastCompactIndex >= 0 ? records.slice(lastCompactIndex + 1) : records
}

function selectRecordsToCompact(records: SessionRecord[]): SessionRecord[] {
  const lastUserIndex = findLastRecordIndex(records, (record) => record.type === 'message' && record.role === 'user')
  if (lastUserIndex <= 0) return []
  return records.slice(0, lastUserIndex)
}

function findLastRecordIndex(records: SessionRecord[], predicate: (record: SessionRecord) => boolean): number {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record && predicate(record)) return index
  }
  return -1
}

async function summarizeRecords(
  input: CompactCheckInput,
  records: SessionRecord[],
  tokenCount: number,
): Promise<{ content: string; usage?: TokenUsage }> {
  const content = [
    'Summarize the conversation context below for continuation after context compaction.',
    'Preserve user goals, decisions, constraints, file paths, tool results, unresolved tasks, and any facts needed to continue.',
    'Write a concise but complete summary. Do not answer the user directly.',
    '',
    `<pre_compact_tokens>${tokenCount}</pre_compact_tokens>`,
    '<conversation>',
    formatRecordsForSummary(records),
    '</conversation>',
  ].join('\n')

  const message: ChatMessage = {
    id: 'compact-request',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  }

  const response = await input.provider.createMessage({
    system: 'You summarize prior conversation context so an agent can continue after compaction.',
    systemBlocks: [
      'You summarize prior conversation context so an agent can continue after compaction.',
    ],
    messages: [message],
    contextItems: [{ kind: 'message', message }],
    tools: [],
    model: input.model,
    promptCacheRetention: input.promptCacheRetention,
    cacheSource: 'compact',
    retry: { callerKind: 'background', persistent: true },
  })

  return {
    content: response.content.trim() || '(No compact summary was produced.)',
    usage: response.usage,
  }
}

function formatRecordsForSummary(records: SessionRecord[]): string {
  return records.map((record) => {
    if (record.type === 'message') {
      return `<message role="${record.role}">\n${record.content}\n</message>`
    }

    if (record.type === 'tool_use') {
      return `<tool_use name="${record.tool}" id="${record.id}">\n${JSON.stringify(record.input ?? {})}\n</tool_use>`
    }

    if (record.type === 'tool_result') {
      return `<tool_result name="${record.tool}" tool_use_id="${record.toolUseId}" ok="${record.ok}">\n${record.content}\n</tool_result>`
    }

    if (record.type === 'compact_boundary') {
      return `<compact_summary>\n${record.summary}\n</compact_summary>`
    }

    if (record.type === 'tool_approval') {
      return `<tool_approval name="${record.tool}" approved="${record.approved}">\n${JSON.stringify(record.input ?? {})}\n</tool_approval>`
    }

    return ''
  }).filter(Boolean).join('\n\n')
}

export function compactBoundaryToMessage(record: CompactBoundaryRecord): ChatMessage {
  return {
    id: record.id,
    role: 'user',
    content: `<system-reminder>\nPrior conversation was compacted. Continue from this summary:\n\n${record.summary}\n</system-reminder>`,
    createdAt: record.createdAt,
  }
}

const DEFAULT_SNIP_MAX_TOKENS = 5_000

export function snipLargeToolResults(
  records: SessionRecord[],
  maxTokens: number = DEFAULT_SNIP_MAX_TOKENS,
): SessionRecord[] {
  return records.map((record) => {
    if (record.type === 'tool_result') {
      const estimatedTokens = countTextTokens(record.content)
      if (estimatedTokens > maxTokens) {
        return {
          ...record,
          content: `[Result truncated: ${record.tool} output exceeded ${maxTokens} tokens (${estimatedTokens} estimated)]`,
        }
      }
    }
    return record
  })
}

function formatCompactError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
