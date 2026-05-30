import { readFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { rememberReadFile } from './fileState.js'

export const readFileTool: Tool = {
  name: 'Read',
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
    await rememberReadFile(absolute, content, context)
    return { ok: true, content }
  },
}
