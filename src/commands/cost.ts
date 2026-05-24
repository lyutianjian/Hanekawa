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

    const lines = [
      'Session usage:',
      `  Cache read:    ${usage.cacheReadInputTokens.toLocaleString()}`,
      `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
      `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
      typeof usage.cost === 'number'
        ? `  Total cost:    ${usage.currency ?? 'USD'} ${formatCost(usage.cost)}`
        : '  Total cost:    unavailable (missing pricing)',
    ]
    context.writeLine(lines.join('\n'))
  },
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
