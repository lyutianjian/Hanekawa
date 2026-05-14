import type { CommandDefinition } from './types.js'

export const clearCommand: CommandDefinition = {
  name: 'clear',
  description: 'Clear conversation history',
  run: async (_args, context) => {
    context.clearMessages()
    context.writeLine('Conversation cleared.')
  },
}
