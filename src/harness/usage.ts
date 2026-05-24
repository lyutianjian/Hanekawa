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

export function formatUsageLine(usage: TokenUsage, pricing?: ModelPricing): string {
  const tokens = `Tokens: cache read ${usage.cacheReadInputTokens}, input ${usage.inputTokens}, output ${usage.outputTokens}`
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
