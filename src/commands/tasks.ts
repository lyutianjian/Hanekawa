import type { CommandDefinition } from './types.js'

export const tasksCommand: CommandDefinition = {
  name: 'tasks',
  description: 'Show background shell and agent tasks',
  async run(_args, context) {
    if (!context.openBackgroundTasks) {
      context.writeLine('Background task panel is not available.')
      return
    }
    context.openBackgroundTasks()
  },
}
