import type { CommandDefinition } from './types.js'

export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: 'Manage auto-compact state',
  argumentHint: 'reset',
  async run(args, context) {
    const subcommand = args.trim().toLowerCase()
    if (subcommand !== 'reset') {
      context.writeLine('Usage: /compact reset')
      return
    }

    if (!context.resetCompactFailureCount) {
      context.writeLine('Compact failure reset is unavailable in this runtime.')
      return
    }

    await context.resetCompactFailureCount()
    context.clearCachedSections?.()
    context.writeLine('Auto-compact failure circuit reset.')
  },
}
