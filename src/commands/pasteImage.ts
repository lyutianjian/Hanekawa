import type { CommandDefinition } from './types.js'

/**
 * `/paste-image`: the explicit fallback for terminals that do not pass
 * Ctrl+V through to the app (design doc §6.2, session S14). Both triggers run
 * the same shell-provided action, which captures the clipboard once — this
 * command never reads the clipboard on its own.
 */
export const pasteImageCommand: CommandDefinition = {
  name: 'paste-image',
  description: 'Attach the image currently on the clipboard',
  run: async (_args, context) => {
    if (!context.pasteImageFromClipboard) {
      context.writeLine('Clipboard image paste is not available in this shell.')
      return
    }
    await context.pasteImageFromClipboard()
  },
}
