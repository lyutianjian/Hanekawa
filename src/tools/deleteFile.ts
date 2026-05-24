import { rm } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { requireFreshRead } from './fileState.js'
import { assertParentNotSymlink } from './pathSafety.js'

export const deleteFileTool: Tool = {
  name: 'deleteFile',
  description: 'Delete a file. This always requires explicit user approval.',
  inputSchema: z.object({
    filePath: z.string().min(1),
  }).strict(),
  riskLevel: 'dangerous',
  isDestructive: true,
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
    return { ok: true, content: `Deleted ${filePath}` }
  },
}
