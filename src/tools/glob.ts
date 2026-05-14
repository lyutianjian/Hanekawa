import fg from 'fast-glob'
import type { Tool } from '../harness/types.js'

interface GlobInput {
  pattern: string
  path?: string
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  riskLevel: 'safe',
  isConcurrencySafe: true,
  async execute(input, context) {
    const options = input as GlobInput
    const cwd = options.path ?? context.cwd
    const entries = await fg(options.pattern, { cwd, dot: false })
    return { ok: true, content: entries.join('\n') || 'No files found.' }
  },
}
