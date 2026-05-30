import type { CommandDefinition } from './types.js'

export const agentsCommand: CommandDefinition = {
  name: 'agents',
  description: 'Manage custom agent definitions',
  argumentHint: 'reload',
  async run(args, context) {
    const subcommand = args.trim()
    if (subcommand !== 'reload') {
      context.writeLine('Usage: /agents reload')
      return
    }
    if (!context.reloadAgentDefinitions) {
      context.writeLine('Agent definition reload is not available.')
      return
    }

    const count = await context.reloadAgentDefinitions()
    context.writeLine(`Reloaded ${count} custom agent definition${count === 1 ? '' : 's'}.`)
  },
}
