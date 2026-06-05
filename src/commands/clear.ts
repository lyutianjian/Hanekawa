import type { CommandDefinition } from './types.js'
import { resetCacheBreakDetection } from '../harness/cacheBreakDetection.js'
import { clearToolSchemaCache } from '../utils/toolSchemaCache.js'

export const clearCommand: CommandDefinition = {
  name: 'clear',
  description: 'Clear conversation history',
  run: async (_args, context) => {
    await context.clearMessages()
    context.clearCachedSections?.()
    clearToolSchemaCache()
    // Reset prompt-cache break detection so the next request starts from a
    // clean baseline; otherwise the prevCacheReadTokens from the discarded
    // session would trigger a false-positive break on the first new turn.
    resetCacheBreakDetection()
    context.writeLine('Conversation cleared. Started a new session.')
  },
}
