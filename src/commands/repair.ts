import type { CommandDefinition } from './types.js'

export const repairCommand: CommandDefinition = {
  name: 'repair',
  description: 'Repair session record invariants',
  async run(_args, context) {
    if (!context.repairRecords) {
      context.writeLine('Session repair is unavailable in this runtime.')
      return
    }

    const result = await context.repairRecords()
    context.invalidateRecordsCache?.()
    context.clearCachedSections?.()

    if (result.repairedCount === 0) {
      context.writeLine('Session invariants checked. No repairs needed.')
      return
    }

    const preview = result.diagnostics
      .slice(0, 5)
      .map((diagnostic) => `  - ${diagnostic.message}`)
    const suffix = result.diagnostics.length > preview.length
      ? `\n  - ...and ${result.diagnostics.length - preview.length} more`
      : ''
    context.writeLine([
      `Session invariants repaired. Added ${result.repairedCount} synthetic tool protocol record${result.repairedCount === 1 ? '' : 's'}.`,
      ...preview,
    ].join('\n') + suffix)
  },
}
