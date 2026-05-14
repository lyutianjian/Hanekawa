import type { CommandDefinition } from './types.js'

export const modelCommand: CommandDefinition = {
  name: 'model',
  description: 'Show or set the current model',
  argumentHint: '[model-name]',
  run: async (args, context) => {
    const currentModel = context.getModel?.() ?? 'unknown'

    if (!args.trim()) {
      context.writeLine(`Current model: ${currentModel}`)
      return
    }

    const newModel = args.trim()
    context.setModel?.(newModel)
    context.writeLine(`Model set to: ${newModel}`)
  },
}
