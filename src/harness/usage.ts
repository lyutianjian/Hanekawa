import type { ModelPricing, TokenUsage } from './types.js'

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
}

/** Whether this usage carries a cache-write count at all. */
export function reportsCacheCreation(usage?: TokenUsage): boolean {
  const value = usage?.cacheCreationInputTokens
  return typeof value === 'number' && Number.isFinite(value)
}

/** Cache writes as a number: absent means "not reported", which costs nothing. */
export function cacheCreationTokens(usage?: TokenUsage): number {
  return reportsCacheCreation(usage) ? usage!.cacheCreationInputTokens as number : 0
}

/**
 * The cache-write field of a sum, present only when a side reported one.
 *
 * Arithmetic over these counts preserves absence rather than materializing a
 * zero: a session on an endpoint that does not report cache writes should keep
 * producing the same three-field usage it always did — in its records, in its
 * metrics and on the wire — instead of carrying a zero that claims the provider
 * answered "no writes".
 */
function sumCacheCreation(
  left: TokenUsage,
  right: TokenUsage,
): Pick<TokenUsage, 'cacheCreationInputTokens'> | Record<string, never> {
  if (!reportsCacheCreation(left) && !reportsCacheCreation(right)) return {}
  return { cacheCreationInputTokens: cacheCreationTokens(left) + cacheCreationTokens(right) }
}

/**
 * The whole prompt of one request: uncached input + cache writes + cache reads.
 *
 * The one place those three are added up. This is what the model was actually
 * sent, so it is both the context-window occupancy and the hit rate's
 * denominator — the same figure Claude Code's status line reports as
 * `context_window.total_input_tokens`. Adding only two of the three (which is
 * what every caller did while writes were folded into `inputTokens`) silently
 * drops every newly cached prefix.
 */
export function promptTokens(usage?: TokenUsage): number {
  if (!usage) return 0
  return usage.inputTokens + cacheCreationTokens(usage) + usage.cacheReadInputTokens
}

/**
 * Cache reads over the whole prompt, or null when nothing was sent at all.
 *
 * Output is not in the denominator: generated tokens can never be served from
 * cache, so folding them in would only drag the number down for a reason nobody
 * can act on. Cache *writes* are, and must be — a write is a miss that was paid
 * for, and a rate that ignored them would read 100% on a cold turn.
 */
export function cacheHitRate(usage: TokenUsage): number | null {
  const total = promptTokens(usage)
  if (total === 0) return null
  return usage.cacheReadInputTokens / total
}

export function addTokenUsage(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    ...sumCacheCreation(left, right),
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

type CompletePricing = ModelPricing & {
  inputPerMillionTokens: number
  outputPerMillionTokens: number
}

export function hasCompletePricing(pricing?: ModelPricing): pricing is CompletePricing {
  return typeof pricing?.inputPerMillionTokens === 'number'
    && Number.isFinite(pricing.inputPerMillionTokens)
    && typeof pricing.outputPerMillionTokens === 'number'
    && Number.isFinite(pricing.outputPerMillionTokens)
}

export function calculateTokenCost(usage: TokenUsage, pricing: CompletePricing): number {
  const cacheReadPrice = pricing.cacheReadInputPerMillionTokens ?? pricing.inputPerMillionTokens
  // Both cache rates fall back to the input rate rather than to zero: a model
  // priced without them is one whose cache rates are unknown, and charging a
  // write nothing would make a cold turn look free.
  const cacheWritePrice = pricing.cacheWriteInputPerMillionTokens ?? pricing.inputPerMillionTokens
  return (usage.cacheReadInputTokens / 1_000_000) * cacheReadPrice
    + (cacheCreationTokens(usage) / 1_000_000) * cacheWritePrice
    + (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokens
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokens
}

/** Token counts with the cost folded in, when the model has complete pricing. */
export type UsageWithCost = TokenUsage & { cost?: number; currency?: string }

/**
 * The one projection from "counts plus a price list" to "counts plus a cost".
 *
 * Two callers, and they must never disagree: `/cost` reads it through
 * `CommandContext.getUsage`, and the desktop's status bar reads the same value
 * off the `snapshot` event. The host computes it because a renderer may not
 * import this layer (`test/rendererImports.test.ts`) — the same bargain
 * `PermissionRequestDto` makes by shipping a preview instead of a filesystem.
 *
 * Incomplete pricing yields the counts unchanged rather than a zero cost: "not
 * priced" and "free" are different answers, and only the first one should read
 * as "unavailable" downstream.
 *
 * The return type is structurally a `CommandUsage`; it is spelled locally so
 * `harness/` does not have to import `commands/`.
 */
export function resolveUsageWithCost(usage: TokenUsage, pricing?: ModelPricing): UsageWithCost {
  if (!hasCompletePricing(pricing)) return usage
  return {
    ...usage,
    cost: calculateTokenCost(usage, pricing),
    currency: pricing.currency ?? 'USD',
  }
}

export function formatUsageLine(usage: TokenUsage, pricing?: ModelPricing, label = 'Tokens'): string {
  const writes = cacheCreationTokens(usage)
  const tokens = `${label}: cache read ${usage.cacheReadInputTokens},${writes > 0 ? ` cache write ${writes},` : ''} input ${usage.inputTokens}, output ${usage.outputTokens}`
  if (!hasCompletePricing(pricing)) return tokens

  const currency = pricing.currency ?? 'USD'
  const cost = calculateTokenCost(usage, { ...pricing, currency })
  return `${tokens} | Cost: ${currency} ${formatCost(cost)}`
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
