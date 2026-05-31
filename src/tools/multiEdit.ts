import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { getReadFileContent, rememberReadFile, requireFreshRead } from './fileState.js'
import { assertParentNotSymlink, assertFileNotSymlink } from './pathSafety.js'
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
  userFacingName: () => 'MultiEdit',
  shouldDisplayResult: () => true,
  getToolUseSummary(input) {
    const parsed = typeof input === 'object' && input !== null
      ? input as { filePath?: unknown; edits?: unknown }
      : undefined
    const filePath = typeof parsed?.filePath === 'string' ? parsed.filePath : undefined
    const editCount = Array.isArray(parsed?.edits) ? parsed.edits.length : undefined
    if (!filePath) return null
    return editCount === undefined ? filePath : `${filePath}, ${editCount} edits`
  },
  getActivityDescription(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? `Editing ${filePath}` : 'Editing file'
  },
  async execute(input, context) {
    const { filePath, edits } = input as { filePath: string; edits: MultiEditItem[] }
    const absolute = assertInsideCwd(context.cwd, filePath)
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }
    // Symlink checks BEFORE reading content to prevent TOCTOU: an attacker
    // could swap the file with a symlink between read and write.
    const unsafeParent = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParent) {
      return unsafeParent
    }
    const unsafeFile = await assertFileNotSymlink(absolute, filePath)
    if (unsafeFile) {
      return unsafeFile
    }

    const originalContent = getReadFileContent(absolute, context) ?? await readFile(absolute, 'utf8')
    // Validate all edits against the original content and find match positions
    const resolved: Array<{ oldString: string; newString: string; index: number; start: number; end: number }> = []
    for (const [index, edit] of edits.entries()) {
      if (edit.oldString.length === 0) {
        return { ok: false, content: `Refusing to edit: edits[${index}].oldString must not be empty.`, errorCode: 'precondition_failed' }
      }

      const matches = findStringMatches(originalContent, edit.oldString)
      if (matches.length !== 1) {
        return multipleMatchFailure(edit.oldString, matches, `edits[${index}].oldString`)
      }
      const start = matches[0].index
      resolved.push({ oldString: edit.oldString, newString: edit.newString, index, start, end: start + edit.oldString.length })
    }

    // Check for overlapping edit ranges
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i]!
        const b = resolved[j]!
        if (a.start < b.end && b.start < a.end) {
          return {
            ok: false,
            content: `Overlapping edits: edits[${a.index}] (${a.start}..${a.end}) overlaps with edits[${b.index}] (${b.start}..${b.end}). Each character can only be edited once.`,
            errorCode: 'precondition_failed',
          }
        }
      }
    }

    // Apply edits from bottom to top so earlier positions remain valid
    resolved.sort((a, b) => b.start - a.start)
    let nextContent = originalContent
    for (const edit of resolved) {
      nextContent = replaceLiteralMatch(nextContent, edit.oldString, edit.newString, edit.start)
    }

    await writeFile(absolute, nextContent, 'utf8')
    await rememberReadFile(absolute, nextContent, context)
    return {
      ok: true,
      content: `Applied ${edits.length} edits to ${filePath}`,
      metadata: {
        display: {
          summary: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${filePath}`,
        },
      },
    }
  },
}
