import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { rememberReadFile, requireFreshRead } from './fileState.js'
import { assertParentNotSymlink } from './pathSafety.js'

export const writeFileTool: Tool = {
  name: 'Write',
  description: 'Write a UTF-8 text file. Existing-file overwrites require confirmation from the harness.',
  inputSchema: z.object({
    filePath: z.string().min(1),
    content: z.string(),
  }).strict(),
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, content } = input as { filePath: string; content: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const unsafeParentBeforeRead = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeRead) {
      return unsafeParentBeforeRead
    }
    const conflict = await detectCaseInsensitiveNameConflict(absolute, filePath)
    if (conflict) {
      return conflict
    }
    const exists = await fileExists(absolute)
    if (exists) {
      const stale = await requireFreshRead(absolute, filePath, context)
      if (stale) {
        return stale
      }
    }
    const unsafeParentBeforeMkdir = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeMkdir) {
      return unsafeParentBeforeMkdir
    }
    await mkdir(path.dirname(absolute), { recursive: true })
    const unsafeParentBeforeWrite = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeWrite) {
      return unsafeParentBeforeWrite
    }
    await writeFile(absolute, content, 'utf8')
    await rememberReadFile(absolute, content, context)
    return { ok: true, content: `Wrote ${filePath}` }
  },
}

async function detectCaseInsensitiveNameConflict(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  const parent = path.dirname(absolute)
  const basename = path.basename(absolute)

  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch {
    return undefined
  }

  const foldedBasename = basename.toLowerCase()
  const conflict = entries.find((entry) => entry.toLowerCase() === foldedBasename && entry !== basename)
  if (!conflict) {
    return undefined
  }

  return {
    ok: false,
    content: `Refusing to create ${filePath}: ${conflict} already exists in the same directory with different casing. Read or address that path before retrying.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      requested: basename,
      existing: conflict,
    },
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch {
    return false
  }
}
