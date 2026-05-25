import type { CommandDefinition } from './types.js'

export const costCommand: CommandDefinition = {
  name: 'cost',
  description: 'Show token usage and cost',
  run: async (_args, context) => {
    const usage = context.getUsage?.()
    if (!usage) {
      context.writeLine('Usage information not available.')
      return
    }
    const summary = await context.getSessionMetricsSummary?.()

    const lines = [
      'Session usage:',
      `  Cache read:    ${usage.cacheReadInputTokens.toLocaleString()}`,
      `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
      `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
      typeof usage.cost === 'number'
        ? `  Total cost:    ${usage.currency ?? 'USD'} ${formatCost(usage.cost)}`
        : '  Total cost:    unavailable (missing pricing)',
    ]
    if (summary) {
      lines.push(
        '',
        'Session cache:',
        `  Cache hit rate:        ${formatPercent(summary.totalCacheHitRate)}`,
        `  Total turns:           ${summary.totalTurns.toLocaleString()}`,
        `  First break turn:      ${formatNullableInteger(summary.firstBreakTurnCount)}`,
        `  Cache breaks:          ${summary.cacheBreakCount.toLocaleString()}`,
        `  Avg compact interval:  ${formatTurns(summary.averageCompactIntervalTurns)}`,
      )
    }
    context.writeLine(lines.join('\n'))
  },
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function formatPercent(value: number | null): string {
  if (value === null) return 'n/a'
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`
}

function formatNullableInteger(value: number | null): string {
  return value === null ? 'n/a' : value.toLocaleString()
}

function formatTurns(value: number | null): string {
  if (value === null) return 'n/a'
  const rounded = Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)
  return `${rounded} turns`
}
