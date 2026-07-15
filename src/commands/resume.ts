import type { CommandDefinition } from './types.js'

export const resumeCommand: CommandDefinition = {
  name: 'resume',
  description: 'Resume a session from the current working directory',
  run: async (args, context) => {
    if (args) {
      context.writeLine('Usage: /resume')
      return
    }
    if (!context.openResumePicker) {
      context.writeLine('Session picker is unavailable in this session.')
      return
    }
    context.openResumePicker()
  },
}
