import type { TokenUsage } from '../../harness/types.js'

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Cache writes, from either shape the API reports them in.
 *
 * `cache_creation_input_tokens` is the scalar every version has sent; the newer
 * `cache_creation` object breaks the same total down by TTL. Summing the object
 * only when the scalar is missing keeps a compatible endpoint that ships one but
 * not the other from reading as zero writes — which would show up as a context
 * window that shrinks whenever a new prefix is cached.
 */
function cacheCreationTokens(typed: Record<string, unknown>): number {
  const scalar = tokenNumber(typed.cache_creation_input_tokens)
  if (scalar > 0) return scalar
  const detail = typed.cache_creation
  if (!detail || typeof detail !== 'object') return 0
  return Object.values(detail as Record<string, unknown>)
    .reduce<number>((sum, value) => sum + tokenNumber(value), 0)
}

/**
 * The three input-side counts stay separate (design: `TokenUsage`).
 *
 * Folding writes into `inputTokens` used to keep the prompt total right while
 * making everything derived from the split wrong: a cache write counted as a
 * miss in the hit rate, and as ordinary input in the cost even though Anthropic
 * bills it above the input rate.
 */
export function normalizeAnthropicUsage(usage: unknown): TokenUsage {
  const typed = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  return {
    inputTokens: tokenNumber(typed.input_tokens),
    cacheCreationInputTokens: cacheCreationTokens(typed),
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
  // No cache-write field exists in this protocol: `prompt_tokens` already covers
  // the whole prompt, so the uncached remainder is input and nothing is written
  // out separately. `cacheCreationInputTokens` stays absent rather than 0 — the
  // distinction is "not reported", not "no writes happened".
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadInputTokens),
    cacheReadInputTokens,
    outputTokens: tokenNumber(typed.completion_tokens),
  }
}
