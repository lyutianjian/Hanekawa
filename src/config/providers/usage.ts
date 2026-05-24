import type { TokenUsage } from '../../harness/types.js'

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function normalizeAnthropicUsage(usage: unknown): TokenUsage {
  const typed = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  return {
    inputTokens: tokenNumber(typed.input_tokens) + tokenNumber(typed.cache_creation_input_tokens),
    cacheReadInputTokens: tokenNumber(typed.cache_read_input_tokens),
    outputTokens: tokenNumber(typed.output_tokens),
  }
}

export function normalizeOpenAIUsage(usage: unknown): TokenUsage {
  const typed = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  const details = typed.prompt_tokens_details && typeof typed.prompt_tokens_details === 'object'
    ? typed.prompt_tokens_details as Record<string, unknown>
    : {}
  const cacheReadInputTokens = tokenNumber(details.cached_tokens)
  const promptTokens = tokenNumber(typed.prompt_tokens)
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadInputTokens),
    cacheReadInputTokens,
    outputTokens: tokenNumber(typed.completion_tokens),
  }
}
