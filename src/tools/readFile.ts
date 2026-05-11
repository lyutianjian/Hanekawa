import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../harness/types.js'

export const readFileTool: Tool = {
  name: 'readFile',
  description: 'Read a UTF-8 text file from the current project.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  riskLevel: 'safe',
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    const absolute = path.resolve(context.cwd, filePath)
    const content = await readFile(absolute, 'utf8')
    context.readFiles.add(absolute)
    context.readFileState ??= new Map()
    context.readFileState.set(absolute, {
      content,
      timestamp: Date.now(),
    })
    return { ok: true, content }
  },
}
