import type { CommandDefinition } from './types.js'

export const modelCommand: CommandDefinition = {
  name: 'model',
  description: 'Show or set the current model',
  argumentHint: '[model-name]',
  run: async (args, context) => {
    const currentModel = context.getModel?.()

    if (!args.trim()) {
      if (context.openModelPicker) {
        context.openModelPicker()
        return
      }

      if (!currentModel) {
        context.writeLine('Current model: unknown')
        return
      }

      context.writeLine([
        'Current model:',
        `  Name:     ${currentModel.key}`,
        `  Provider: ${currentModel.providerName}`,
        `  Model ID: ${currentModel.model}`,
      ].join('\n'))
      return
    }

    const newModel = args.trim()
    if (!context.setModel) {
      context.writeLine('Model switching is not available.')
      return
    }

    const result = await context.setModel(newModel)
    if (result && !result.ok) {
      const lines = [result.message]
      if (result.availableModels && result.availableModels.length > 0) {
        lines.push(`Available models: ${result.availableModels.join(', ')}`)
      }
      context.writeLine(lines.join('\n'))
      return
    }

    context.clearCachedSections?.()
    const model = result?.ok ? result.model : { key: newModel, model: newModel, providerName: 'unknown' }
    context.writeLine(`Model set to: ${model.key} (${model.providerName}: ${model.model})`)
  },
}
