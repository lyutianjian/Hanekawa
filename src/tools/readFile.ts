import { readFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { evictOldestIfNeeded } from '../utils/cache.js'
import { captureReadFileState } from './fileState.js'

export const readFileTool: Tool = {
  name: 'readFile',
  description: 'Read a UTF-8 text file from the current project.',
  inputSchema: z.object({
    filePath: z.string().min(1),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const content = await readFile(absolute, 'utf8')
    context.readFiles.add(absolute)
    context.readFileState ??= new Map()
    evictOldestIfNeeded(context.readFileState, 100)
    context.readFileState.set(absolute, await captureReadFileState(absolute, content))
    return { ok: true, content }
  },
}
