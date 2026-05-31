import { formatCacheHitRate } from '../harness/cacheBreakDetection.js'
import { formatUsageLine } from '../harness/usage.js'
import type { ModelPricing } from '../harness/types.js'
import type { TUIUsage } from './types.js'

export function formatStatusUsage(usage: TUIUsage, pricing?: ModelPricing): string {
  if (!usage.lastTurn) return 'Ready'

  const usageText = formatUsageLine(usage.lastTurn, pricing, 'Turn')
  const cacheText = formatCacheHitRate(usage.lastTurn)
  if (cacheText === 'cache: n/a') return usageText

  return `${usageText} | ${cacheText}`
}
