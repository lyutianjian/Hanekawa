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
      `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
      `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
      `  Total cost:    $${usage.cost.toFixed(4)}`,
    ]
    context.writeLine(lines.join('\n'))
  },
}
