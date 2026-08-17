import type { CommandDefinition } from './types.js'

export const rewindCommand: CommandDefinition = {
  name: 'rewind',
  description: 'Return to an earlier point in this session',
  run: async (args, context) => {
    if (args) {
      context.writeLine('Usage: /rewind')
      return
    }
    if (!context.openRewindPanel) {
      context.writeLine('Rewind is unavailable in this session.')
      return
    }
    context.openRewindPanel()
  },
}
