import type { CommandDefinition } from './types.js'
import { listCommands } from './registry.js'

export const helpCommand: CommandDefinition = {
  name: 'help',
  description: 'Show available commands',
  run: async (_args, context) => {
    const commands = listCommands()
    if (context.openCommandView) {
      context.openCommandView({
        kind: 'list',
        title: 'Help',
        subtitle: `${commands.length} available commands`,
        items: commands
          .map((cmd) => ({
            id: cmd.name,
            label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
            description: cmd.description,
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      })
      return
    }
    const lines = ['Available commands:', '']
    for (const cmd of commands) {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ''
      lines.push(`  /${cmd.name}${hint}  ${cmd.description}`)
    }
    context.writeLine(lines.join('\n'))
  },
}
