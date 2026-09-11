import type { CommandDefinition } from './types.js'

/**
 * Open the editor for endpoints / models / routing: the TUI's full-screen
 * panel, or the desktop settings screen's「模型与服务商」page — each shell
 * decides what the request means. Falls back to a help message if the host
 * runtime provides no opener at all.
 */
export const providerCommand: CommandDefinition = {
  name: 'provider',
  description: 'Manage endpoints, models, and routing',
  run: async (_args, context) => {
    if (!context.openProviderPanel) {
      context.writeLine('Provider panel is unavailable in this session.')
      return
    }
    context.openProviderPanel()
  },
}
