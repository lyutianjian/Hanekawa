import type { ChatMessage, ModelContextItem, SessionRecord } from '../harness/types.js'

export interface TokenCount {
  total: number
  messages: number[]
}

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MICROCOMPACT_THRESHOLD_RATIO = 0.65
export const SNIP_THRESHOLD_RATIO = 0.8
export const AUTOCOMPACT_THRESHOLD_RATIO = 0.9
export const SNIP_HEAD_TURNS = 3
export const SNIP_TAIL_TURNS = 12
export const SNIP_MAX_TURNS = 24

export interface ContextManagementConfig {
  contextWindow: number
  summaryOutputTokens: number
  autoCompactBufferTokens: number
  manualCompactBufferTokens: number
  microCompactThresholdRatio: number
  snipThresholdRatio: number
  autoCompactThresholdRatio: number
  snipHeadTurns: number
  snipTailTurns: number
  snipMaxTurns: number
}

export const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementConfig = {
  contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
  summaryOutputTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  autoCompactBufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
  manualCompactBufferTokens: MANUAL_COMPACT_BUFFER_TOKENS,
  microCompactThresholdRatio: MICROCOMPACT_THRESHOLD_RATIO,
  snipThresholdRatio: SNIP_THRESHOLD_RATIO,
  autoCompactThresholdRatio: AUTOCOMPACT_THRESHOLD_RATIO,
  snipHeadTurns: SNIP_HEAD_TURNS,
  snipTailTurns: SNIP_TAIL_TURNS,
  snipMaxTurns: SNIP_MAX_TURNS,
}

export function getEffectiveContextWindowSize(config: Partial<ContextManagementConfig> = {}): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, merged.contextWindow - merged.summaryOutputTokens)
}

export function getAutoCompactThreshold(config: Partial<ContextManagementConfig> = {}): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  const ratioThreshold = Math.floor(getEffectiveContextWindowSize(merged) * merged.autoCompactThresholdRatio)
  const bufferThreshold = getEffectiveContextWindowSize(merged) - merged.autoCompactBufferTokens
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold))
}

export function getMicroCompactThreshold(config: Partial<ContextManagementConfig> = {}): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, Math.floor(getEffectiveContextWindowSize(merged) * merged.microCompactThresholdRatio))
}

export function getSnipThreshold(config: Partial<ContextManagementConfig> = {}): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, Math.floor(getEffectiveContextWindowSize(merged) * merged.snipThresholdRatio))
}

export function getManualCompactThreshold(config: Partial<ContextManagementConfig> = {}): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, getEffectiveContextWindowSize(merged) - merged.manualCompactBufferTokens)
}

export function countTextTokens(text: string): number {
  // Conservative fallback for code/JSON/Markdown-heavy context. Real provider
  // usage is preferred where available; this estimate intentionally compacts
  // early rather than risking an over-limit request.
  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length
  const nonAsciiChars = text.length - asciiChars
  return Math.ceil(asciiChars / 3.0 + nonAsciiChars / 1.2)
}

export function countMessageTokens(message: ChatMessage): number {
  return countTextTokens(message.content)
}

export function countMessagesTokens(messages: ChatMessage[]): TokenCount {
  const counts = messages.map(countMessageTokens)
  return {
    total: counts.reduce((a, b) => a + b, 0),
    messages: counts,
  }
}

export function getAvailableContextTokens(
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): number {
  const systemTokens = system ? countTextTokens(system) : 0
  return getEffectiveContextWindowSize(config) - systemTokens - 1000
}

export function selectMessagesForContext(
  messages: ChatMessage[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): ChatMessage[] {
  const availableTokens = getAvailableContextTokens(config, system)

  if (availableTokens <= 0) {
    return []
  }

  const result: ChatMessage[] = []
  let used = 0

  for (const message of messages) {
    const tokens = countMessageTokens(message)
    if (used + tokens > availableTokens) {
      break
    }
    result.push(message)
    used += tokens
  }

  return result
}

export function selectContextItemsForContext(
  items: ModelContextItem[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): ModelContextItem[] {
  const availableTokens = getAvailableContextTokens(config, system)

  if (availableTokens <= 0) {
    const lastUserItem = [...items].reverse().find(
      (item) => item.kind === 'message' && item.message.role === 'user',
    )
    return lastUserItem ? [lastUserItem] : []
  }

  const result: ModelContextItem[] = []
  let used = 0

  for (const item of [...items].reverse()) {
    const tokens = countContextItemTokens(item)
    if (used + tokens > availableTokens) {
      if (result.length > 0) break
      continue
    }
    result.push(item)
    used += tokens
  }

  return repairToolPairing(result.reverse())
}

export function countContextItemTokens(item: ModelContextItem): number {
  if (item.kind === 'message') {
    return countMessageTokens(item.message)
  }

  if (item.kind === 'tool_use') {
    return countTextTokens(`${item.tool}\n${JSON.stringify(item.input ?? {})}`)
  }

  return countTextTokens(`${item.tool}\n${item.content}`)
}

export function countSessionRecordTokens(record: SessionRecord): number {
  if (record.type === 'message') {
    return countMessageTokens(record)
  }

  if (record.type === 'tool_use') {
    return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`)
  }

  if (record.type === 'tool_result') {
    if (typeof record._tokens === 'number') return record._tokens
    return countTextTokens(`${record.tool}\n${record.content}`)
  }

  if (record.type === 'compact_boundary') {
    return countTextTokens(record.summary)
  }

  if (record.type === 'tool_approval') {
    return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`)
  }

  if (record.type === 'tool_use_summary') {
    return countTextTokens(record.summary)
  }

  return 0
}

export function countSessionRecordsTokens(records: SessionRecord[], system?: string): number {
  return records.reduce((sum, record) => sum + countSessionRecordTokens(record), system ? countTextTokens(system) : 0)
}

function repairToolPairing(items: ModelContextItem[]): ModelContextItem[] {
  const toolUseIds = new Set(
    items
      .filter((item): item is ModelContextItem & { kind: 'tool_use' } => item.kind === 'tool_use')
      .map((item) => item.id),
  )
  const toolResultIds = new Set(
    items
      .filter((item): item is ModelContextItem & { kind: 'tool_result' } => item.kind === 'tool_result')
      .map((item) => item.toolUseId),
  )

  return items.filter((item) => {
    if (item.kind === 'tool_use') return toolResultIds.has(item.id)
    if (item.kind === 'tool_result') return toolUseIds.has(item.toolUseId)
    return true
  })
}
