import { rm } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { assertInsideCwd } from '../../utils/paths.js'
import { requireFreshRead } from '../fileState.js'
import { assertParentNotSymlink } from '../pathSafety.js'
import { DESCRIPTION } from './prompt.js'

export const deleteFileTool: Tool = {
  name: 'Delete',
  description: DESCRIPTION,
  searchHint: 'remove delete file',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory.'),
  }).strict(),
  riskLevel: 'dangerous',
  isDestructive: true,
  userFacingName: () => 'Delete',
  getToolUseSummary: filePathSummary,
  shouldDisplayResult: () => true,
  getActivityDescription(input) {
    const filePath = filePathSummary(input)
    return filePath ? `Deleting ${filePath}` : 'Deleting file'
  },
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }
    const unsafeParent = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParent) {
      return unsafeParent
    }
    await rm(absolute, { force: false })
    context.readFiles.delete(absolute)
    context.readFileState?.delete(absolute)
    return {
      ok: true,
      content: `Deleted ${filePath}`,
      metadata: {
        display: {
          summary: `Deleted ${filePath}`,
        },
      },
    }
  },
}

function filePathSummary(input: unknown): string | null {
  const filePath = typeof input === 'object' && input !== null
    ? (input as { filePath?: unknown }).filePath
    : undefined
  return typeof filePath === 'string' ? filePath : null
}
