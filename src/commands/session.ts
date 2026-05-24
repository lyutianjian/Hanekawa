import type { CommandDefinition } from './types.js'

export const sessionCommand: CommandDefinition = {
  name: 'session',
  description: 'Show current session info',
  run: async (_args, context) => {
    const lines = [
      'Session info:',
      `  ID:  ${context.sessionId}`,
      `  CWD: ${context.cwd}`,
    ]
    context.writeLine(lines.join('\n'))
  },
}
