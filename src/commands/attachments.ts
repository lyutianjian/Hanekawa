import type { CommandDefinition } from './types.js'

/**
 * `/attachments`: the draft image list and its management (session S14 work
 * item 2). Listing, removal by number, and clearing all run against the
 * shell's draft state; the files themselves stay with the session that owns
 * them — nothing here deletes stored attachments.
 */
export const attachmentsCommand: CommandDefinition = {
  name: 'attachments',
  description: 'List or remove draft image attachments',
  argumentHint: '[list | remove <n> | clear]',
  run: async (args, context) => {
    if (!context.listDraftAttachments || !context.removeDraftAttachment || !context.clearDraftAttachments) {
      context.writeLine('Draft image attachments are not available in this shell.')
      return
    }

    const trimmed = args.trim().toLowerCase()
    if (trimmed === '' || trimmed === 'list') {
      const lines = context.listDraftAttachments()
      if (lines.length === 0) {
        context.writeLine('No draft images. Paste an image path, or use /paste-image.')
        return
      }
      context.writeLine(['Draft images (attached to your next message):', ...lines].join('\n'))
      return
    }

    if (trimmed === 'clear') {
      context.clearDraftAttachments()
      context.writeLine('Draft images cleared.')
      return
    }

    const removeMatch = trimmed.match(/^remove\s+(\d+)$/)
    if (removeMatch) {
      const index = Number(removeMatch[1])
      const result = context.removeDraftAttachment(index)
      context.writeLine(result.ok ? `Removed image ${index}.` : (result.message ?? `No image ${index}.`))
      return
    }

    context.writeLine('Usage: /attachments [list | remove <n> | clear]')
  },
}
