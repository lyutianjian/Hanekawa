import type { CommandDefinition } from './types.js'

export const sessionCommand: CommandDefinition = {
  name: 'session',
  description: 'Show current session info',
  run: async (_args, context) => {
    if (context.openCommandView) {
      context.openCommandView({
        kind: 'info',
        title: 'Session',
        subtitle: 'Current conversation and working directory',
        sections: [{
          rows: [
            { label: 'Session ID', value: context.sessionId },
            { label: 'Working directory', value: context.cwd },
          ],
        }],
      })
      return
    }
    const lines = [
      'Session info:',
      `  ID:  ${context.sessionId}`,
      `  CWD: ${context.cwd}`,
    ]
    context.writeLine(lines.join('\n'))
  },
}
