import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { readFileAndRemember } from './fileState.js'

export const readFileTool: Tool = {
  name: 'Read',
  description: 'Read a UTF-8 text file from the current project.',
  inputSchema: z.object({
    filePath: z.string().min(1),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  userFacingName: () => 'Read',
  getToolUseSummary(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? filePath : null
  },
  getActivityDescription(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? `Reading ${filePath}` : 'Reading file'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const content = await readFileAndRemember(absolute, context)
    const lineCount = countLines(content)
    return {
      ok: true,
      content,
      metadata: {
        display: {
          summary: `Read ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`,
        },
      },
    }
  },
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  return content.endsWith('\n')
    ? content.slice(0, -1).split('\n').length
    : content.split('\n').length
}
