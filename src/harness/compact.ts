import { randomUUID } from 'node:crypto'
import type { ChatMessage, CompactBoundaryRecord, ModelProvider, SessionRecord, Tool, TokenUsage } from './types.js'
import type { ActiveModelRuntime } from './loop.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import {
  countTextTokens,
  countSessionRecordsTokens,
  getAutoCompactThreshold,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import { getRecordsAfterLastCompact } from './requestPrep.js'

const COMPACT_FAILURE_LIMIT = 3
const compactFailuresByKey = new Map<string, number>()
const compactRunsByKey = new Map<string, Promise<CompactCheckResult>>()

export interface CompactCheckInput {
  records: SessionRecord[]
  provider: ModelProvider
  model: string
  compactRuntime?: ActiveModelRuntime
  tools: Tool[]
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  lastResponseTokenCount?: number
  lastResponseRecordId?: string
  lastResponseRecordCount?: number
  promptCacheRetention?: 'in_memory' | '24h'
  turnId?: string
  circuitKey?: string
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  appendRecord(record: SessionRecord): Promise<void>
  onBeforeCompact?(event: CompactHookEvent): Promise<void>
  onAfterCompact?(event: CompactHookEvent & { summary: string; postTokens: number; compactDurationMs: number }): Promise<void>
}

export interface CompactHookEvent {
  trigger: 'auto'
  preTokens: number
  recordCount: number
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

  const compactStartedAt = Date.now()
  await runBeforeCompactHook(input, tokenCount, recordsToCompact.length)

  try {
    const summary = await summarizeRecords(input, recordsToCompact, tokenCount)
    const postTokens = countTextTokens(summary.content)
    const compactDurationMs = Date.now() - compactStartedAt
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
    await runAfterCompactHook(input, {
      trigger: 'auto',
      preTokens: tokenCount,
      recordCount: recordsToCompact.length,
      summary: summary.content,
      postTokens,
      compactDurationMs,
    })

    return {
      compacted: true,
      usage: addTokenUsage({ ...EMPTY_TOKEN_USAGE }, summary.usage),
      metrics: {
        preTokens: tokenCount,
        postTokens,
        compactDurationMs,
      },
    }
  } catch (error) {
    const failureCount = currentFailures + 1
    await setCompactFailureCount(input, circuitKey, failureCount)
    await appendCompactFailureRecord(input, error, failureCount, tokenCount)
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }
}

async function runBeforeCompactHook(input: CompactCheckInput, tokenCount: number, recordCount: number): Promise<void> {
  try {
    await input.onBeforeCompact?.({
      trigger: 'auto',
      preTokens: tokenCount,
      recordCount,
    })
  } catch (hookError) {
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error('[compact] preCompact hook failed:', hookError)
    }
  }
}

async function runAfterCompactHook(
  input: CompactCheckInput,
  event: CompactHookEvent & { summary: string; postTokens: number; compactDurationMs: number },
): Promise<void> {
  try {
    await input.onAfterCompact?.(event)
  } catch (hookError) {
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error('[compact] postCompact hook failed:', hookError)
    }
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

  const pendingTokens = countPendingRecordTokens(input)
  if (pendingTokens === undefined) {
    return countSessionRecordsTokens(compactableRecords, input.system)
  }
  return input.lastResponseTokenCount + pendingTokens
}

function countPendingRecordTokens(input: CompactCheckInput): number | undefined {
  if (input.lastResponseRecordId === undefined && input.lastResponseRecordCount === undefined) return 0

  const boundaryIndex = findLastResponseBoundaryIndex(input)
  if (boundaryIndex === undefined) return undefined

  const pendingRecords = input.records.slice(boundaryIndex + 1)
  let skippedResponseMessage = false

  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordsTokens([record])
  }, 0)
}

function findLastResponseBoundaryIndex(input: CompactCheckInput): number | undefined {
  if (input.lastResponseRecordId) {
    const index = input.records.findIndex((record) => record.id === input.lastResponseRecordId)
    return index >= 0 ? index : undefined
  }

  if (input.lastResponseRecordCount === undefined) return undefined
  return input.lastResponseRecordCount - 1
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

  const runtime = input.compactRuntime
  const provider = runtime?.provider ?? input.provider
  const model = runtime?.model ?? input.model
  const promptCacheRetention = runtime?.promptCacheRetention ?? input.promptCacheRetention

  const response = await provider.createMessage({
    system: 'You summarize prior conversation context so an agent can continue after compaction.',
    systemBlocks: [
      'You summarize prior conversation context so an agent can continue after compaction.',
    ],
    messages: [message],
    contextItems: [{ kind: 'message', message }],
    tools: [],
    model,
    promptCacheRetention,
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

    if (record.type === 'tool_use_summary') {
      return `<tool_use_summary tool_use_ids="${record.toolUseIds.join(',')}">\n${record.summary}\n</tool_use_summary>`
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
