import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult } from '../harness/types.js'

export async function assertParentNotSymlink(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  // Walk up from the file's directory to the filesystem root, checking each
  // ancestor for symlinks. This prevents attacks where a symlink is placed at
  // a higher ancestor to redirect writes outside the intended directory.
  let current = path.dirname(absolute)
  const root = path.parse(current).root

  while (current && current !== root) {
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Directory doesn't exist yet — no symlink risk at this level.
        current = path.dirname(current)
        continue
      }
      throw error
    }

    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        content: `Refusing to modify ${filePath}: ancestor directory is a symlink.`,
        errorCode: 'precondition_failed',
        errorDetails: {
          symlinkAncestor: current,
        },
      }
    }
    current = path.dirname(current)
  }
  return undefined
}

export async function assertFileNotSymlink(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  let fileStat
  try {
    fileStat = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  if (!fileStat.isSymbolicLink()) return undefined

  return {
    ok: false,
    content: `Refusing to modify ${filePath}: target is a symbolic link.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      path: absolute,
    },
  }
}
