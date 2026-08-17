import type { ModelPricing, TokenUsage } from './types.js'

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
}

export function addTokenUsage(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

export function hasCompletePricing(pricing?: ModelPricing): pricing is Required<ModelPricing> {
  return typeof pricing?.inputPerMillionTokens === 'number'
    && Number.isFinite(pricing.inputPerMillionTokens)
    && typeof pricing.outputPerMillionTokens === 'number'
    && Number.isFinite(pricing.outputPerMillionTokens)
}

export function calculateTokenCost(usage: TokenUsage, pricing: ModelPricing & { inputPerMillionTokens: number; outputPerMillionTokens: number }): number {
  const cacheReadPrice = pricing.cacheReadInputPerMillionTokens ?? pricing.inputPerMillionTokens
  return (usage.cacheReadInputTokens / 1_000_000) * cacheReadPrice
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
  const tokens = `${label}: cache read ${usage.cacheReadInputTokens}, input ${usage.inputTokens}, output ${usage.outputTokens}`
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
