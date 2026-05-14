import type { CommandDefinition } from './types.js'
import { listCommands } from './registry.js'

export const helpCommand: CommandDefinition = {
  name: 'help',
  description: 'Show available commands',
  run: async (_args, context) => {
    const commands = listCommands()
    const lines = ['Available commands:', '']
    for (const cmd of commands) {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ''
      lines.push(`  /${cmd.name}${hint}  ${cmd.description}`)
    }
    context.writeLine(lines.join('\n'))
  },
}
