import type { ToolContext } from '../harness/types.js'

/**
 * Hands a soon-to-be-written path to file history. Backing up is best effort:
 * losing a checkpoint must never turn a valid edit into a tool failure, so a
 * missing hook and a throwing hook behave the same.
 */
export async function trackFileEdit(context: ToolContext, absolutePath: string): Promise<void> {
  try {
    await context.trackFileEdit?.(absolutePath)
  } catch {
    // ignored: the write proceeds without a backup
  }
}
