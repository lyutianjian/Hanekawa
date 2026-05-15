import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'

export const writeFileTool: Tool = {
  name: 'writeFile',
  description: 'Write a UTF-8 text file. Existing-file overwrites require confirmation from the harness.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['filePath', 'content'],
    additionalProperties: false,
  },
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, content } = input as { filePath: string; content: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    return { ok: true, content: `Wrote ${filePath}` }
  },
}
