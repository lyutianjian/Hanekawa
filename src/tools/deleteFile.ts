import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../harness/types.js'

export const deleteFileTool: Tool = {
  name: 'deleteFile',
  description: 'Delete a file. This always requires explicit user approval.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  riskLevel: 'dangerous',
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    await rm(path.resolve(context.cwd, filePath), { force: false })
    return { ok: true, content: `Deleted ${filePath}` }
  },
}
