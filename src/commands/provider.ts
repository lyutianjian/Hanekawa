import type { CommandDefinition } from './types.js'

/**
 * Open the /provider full-screen panel for editing endpoints / models /
 * profiles / routing. Falls back to a help message if the host runtime
 * does not provide an opener (e.g. when commands are dispatched outside
 * the TUI).
 */
export const providerCommand: CommandDefinition = {
  name: 'provider',
  description: 'Manage endpoints, models, profiles, and routing',
  run: async (_args, context) => {
    if (!context.openProviderPanel) {
      context.writeLine('Provider panel is unavailable in this session.')
      return
    }
    context.openProviderPanel()
  },
}
