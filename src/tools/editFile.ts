import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { captureReadFileState, requireFreshRead } from './fileState.js'
import { assertParentNotSymlink } from './pathSafety.js'

export const editFileTool: Tool = {
  name: 'editFile',
  description: 'Replace an exact string in an existing UTF-8 text file.',
  inputSchema: z.object({
    filePath: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
  }).strict(),
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, oldString, newString } = input as { filePath: string; oldString: string; newString: string }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }
    if (oldString.length === 0) {
      return { ok: false, content: 'Refusing to edit: oldString must not be empty.', errorCode: 'precondition_failed' }
    }
    const original = await readFile(absolute, 'utf8')
    const occurrences = original.split(oldString).length - 1
    if (occurrences !== 1) {
      return { ok: false, content: `Expected exactly one match for oldString, found ${occurrences}.`, errorCode: 'precondition_failed' }
    }
    const nextContent = original.replace(oldString, newString)
    const unsafeParent = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParent) {
      return unsafeParent
    }
    await writeFile(absolute, nextContent, 'utf8')
    context.readFileState?.set(absolute, await captureReadFileState(absolute, nextContent))
    return { ok: true, content: `Edited ${filePath}` }
  },
}
