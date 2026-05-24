import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult } from '../harness/types.js'

export async function assertParentNotSymlink(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  const parent = path.dirname(absolute)

  let parentStat
  try {
    parentStat = await lstat(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  if (!parentStat.isSymbolicLink()) return undefined

  return {
    ok: false,
    content: `Refusing to modify ${filePath}: parent directory is a symlink.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      parent,
    },
  }
}
