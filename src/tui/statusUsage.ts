import type { TUIUsage } from './types.js'

export function formatStatusUsage(usage: TUIUsage): string {
  if (!usage.lastTurn) return 'Ready'

  const t = usage.lastTurn
  const total = t.inputTokens + t.cacheReadInputTokens
  const cacheRate = total > 0 ? Math.round((t.cacheReadInputTokens / total) * 100) : 0
  const parts = [`↑${t.inputTokens} ↓${t.outputTokens}`]
  if (t.cacheReadInputTokens > 0) parts.push(`⚡${t.cacheReadInputTokens}`)
  if (cacheRate > 0) parts.push(`${cacheRate}%`)

  return parts.join(' ')
}
