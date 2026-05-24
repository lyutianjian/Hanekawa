import fg from 'fast-glob'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'

interface GlobInput {
  pattern: string
  path?: string
}

export const globTool: Tool = {
  name: 'Glob',
  description: 'Find files matching a glob pattern.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  async execute(input, context) {
    const options = input as GlobInput
    const cwd = options.path ? assertInsideCwd(context.cwd, options.path) : context.cwd
    const entries = await fg(options.pattern, { cwd, dot: false })
    return { ok: true, content: entries.join('\n') || 'No files found.' }
  },
}
