import { randomUUID } from 'node:crypto'
import type { ChatMessage, CompactBoundaryRecord, ModelProvider, SessionRecord, Tool, TokenUsage } from './types.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import {
  countTextTokens,
  countSessionRecordsTokens,
  getAutoCompactThreshold,
  type ContextManagementConfig,
} from '../prompts/budget.js'

export interface CompactCheckInput {
  records: SessionRecord[]
  provider: ModelProvider
  model: string
  tools: Tool[]
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  lastUsageTokenCount?: number
  promptCacheRetention?: 'in_memory' | '24h'
  appendRecord(record: SessionRecord): Promise<void>
}

export interface CompactCheckResult {
  compacted: boolean
  usage: TokenUsage
}

export async function autoCompactIfNeeded(input: CompactCheckInput): Promise<CompactCheckResult> {
  const compactableRecords = getRecordsAfterLastCompact(input.records)
  const tokenCount = input.lastUsageTokenCount ?? countSessionRecordsTokens(compactableRecords, input.system)
  const threshold = getAutoCompactThreshold(input.contextManagement)

  if (tokenCount < threshold) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  const recordsToCompact = selectRecordsToCompact(compactableRecords)
  if (recordsToCompact.length === 0) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  const summary = await summarizeRecords(input, recordsToCompact, tokenCount)
  await input.appendRecord({
    id: randomUUID(),
    type: 'compact_boundary',
    summary: summary.content,
    preTokens: tokenCount,
    createdAt: new Date().toISOString(),
  })

  return {
    compacted: true,
    usage: addTokenUsage({ ...EMPTY_TOKEN_USAGE }, summary.usage),
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

    return `<tool_approval name="${record.tool}" approved="${record.approved}">\n${JSON.stringify(record.input ?? {})}\n</tool_approval>`
  }).join('\n\n')
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
