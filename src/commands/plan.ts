import type { CommandDefinition } from './types.js'

export const planCommand: CommandDefinition = {
  name: 'plan',
  description: 'Enter plan mode or show the current plan',
  argumentHint: '[open]',
  run: async (args, context) => {
    const description = args.trim()
    const subcommand = description.toLowerCase()

    if (context.getPermissionMode?.() !== 'plan') {
      if (!context.enterPlanMode) {
        context.writeLine('Plan mode is unavailable in this runtime.')
        return
      }
      await context.enterPlanMode()
      context.writeLine('Enabled plan mode.')
      if (subcommand === 'open') {
        return
      }
      if (description.length > 0 && context.submitQuery) {
        await context.submitQuery(description)
      }
      return
    }

    if (subcommand && subcommand !== 'open') {
      context.writeLine('Usage: /plan [open]')
      return
    }

    if (subcommand === 'open') {
      if (!context.openPlanFile) {
        context.writeLine('Opening the plan file is unavailable in this runtime.')
        return
      }
      const result = await context.openPlanFile()
      context.writeLine(result.message)
      return
    }

    if (!context.readPlanFile) {
      context.writeLine('Plan mode is active, but the plan file is unavailable in this runtime.')
      return
    }

    const { path, content } = await context.readPlanFile()
    if (!content || content.trim().length === 0) {
      context.writeLine(`Plan mode is active. No draft plan written yet.\nOptional draft file: ${path}\nPreferred submit path: ExitPlanMode({ plan: "..." })`)
      return
    }

    context.writeLine(`Current plan draft\n${path}\n\n${content}`)
  },
}
