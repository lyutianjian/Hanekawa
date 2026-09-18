import { cacheCreationTokens, cacheHitRate } from '../harness/usage.js'
import type { TUIUsage } from './types.js'

export function formatStatusUsage(usage: TUIUsage): string {
  if (!usage.lastRequest) return 'Ready'

  const t = usage.lastRequest
  const rate = cacheHitRate(t)
  // `↑` is the whole uncached side — input plus what was written into the cache
  // — so the three figures on this line still add up to the request.
  const parts = [`↑${t.inputTokens + cacheCreationTokens(t)} ↓${t.outputTokens}`]
  if (t.cacheReadInputTokens > 0) parts.push(`⚡${t.cacheReadInputTokens}`)
  if (rate !== null && rate > 0) parts.push(`${Math.round(rate * 100)}%`)

  return parts.join(' ')
}
