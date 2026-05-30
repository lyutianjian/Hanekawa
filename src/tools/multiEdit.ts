import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { getReadFileContent, rememberReadFile, requireFreshRead } from './fileState.js'
import { assertParentNotSymlink } from './pathSafety.js'
import { findStringMatches, multipleMatchFailure, replaceLiteralMatch } from './editFile.js'

interface MultiEditItem {
  oldString: string
  newString: string
}

export const multiEditTool: Tool = {
  name: 'MultiEdit',
  description: 'Apply multiple exact string replacements to one existing UTF-8 text file atomically.',
  inputSchema: z.object({
    filePath: z.string().min(1),
    edits: z.array(z.object({
      oldString: z.string().min(1),
      newString: z.string(),
    }).strict()).min(1),
  }).strict(),
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, edits } = input as { filePath: string; edits: MultiEditItem[] }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }

    let nextContent = getReadFileContent(absolute, context) ?? await readFile(absolute, 'utf8')
    for (const [index, edit] of edits.entries()) {
      if (edit.oldString.length === 0) {
        return { ok: false, content: `Refusing to edit: edits[${index}].oldString must not be empty.`, errorCode: 'precondition_failed' }
      }

      const matches = findStringMatches(nextContent, edit.oldString)
      if (matches.length !== 1) {
        return multipleMatchFailure(edit.oldString, matches, `edits[${index}].oldString`)
      }
      nextContent = replaceLiteralMatch(nextContent, edit.oldString, edit.newString, matches[0].index)
    }

    const unsafeParent = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParent) {
      return unsafeParent
    }

    await writeFile(absolute, nextContent, 'utf8')
    await rememberReadFile(absolute, nextContent, context)
    return { ok: true, content: `Applied ${edits.length} edits to ${filePath}` }
  },
}
