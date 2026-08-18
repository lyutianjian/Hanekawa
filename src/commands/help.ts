import type { CommandDefinition } from './types.js'
import type { CommandRegistry } from './registry.js'

/**
 * `/help` is the one command that reads the registry, so it closes over the one
 * it belongs to rather than `CommandContext` growing a member every other
 * command would have to ignore. Same shape as `createXxxTool(deps)` in
 * `src/tools/`.
 */
export function createHelpCommand(registry: CommandRegistry): CommandDefinition {
  return {
    name: 'help',
    description: 'Show available commands',
    run: async (_args, context) => {
      const commands = registry.list()
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
}
