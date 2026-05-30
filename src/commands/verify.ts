import type { CommandDefinition } from './types.js'

export const verifyCommand: CommandDefinition = {
  name: 'verify',
  description: 'Run an adversarial verification agent against the last assistant turn',
  argumentHint: '[focus]',
  run: async (args, context) => {
    if (!context.runVerification) {
      context.writeLine('/verify is unavailable in this runtime.')
      return
    }

    context.writeLine('Starting adversarial verification...')
    const result = await context.runVerification(args)
    context.writeLine(result)
  },
}
