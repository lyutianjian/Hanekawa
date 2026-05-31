import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { getReadFileContent, rememberReadFile, requireFreshRead } from './fileState.js'
import { assertParentNotSymlink, assertFileNotSymlink } from './pathSafety.js'

export const editFileTool: Tool = {
  name: 'Edit',
  description: 'Replace an exact string in an existing UTF-8 text file.',
  inputSchema: z.object({
    filePath: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
  }).strict(),
  riskLevel: 'confirm',
  userFacingName: () => 'Edit',
  getToolUseSummary: filePathSummary,
  shouldDisplayResult: () => true,
  getActivityDescription(input) {
    const filePath = filePathSummary(input)
    return filePath ? `Editing ${filePath}` : 'Editing file'
  },
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
    const original = getReadFileContent(absolute, context) ?? await readFile(absolute, 'utf8')
    const matches = findStringMatches(original, oldString)
    if (matches.length !== 1) {
      return multipleMatchFailure(oldString, matches)
    }
    const nextContent = replaceLiteralMatch(original, oldString, newString, matches[0].index)
    await writeFile(absolute, nextContent, 'utf8')
    await rememberReadFile(absolute, nextContent, context)
    return {
      ok: true,
      content: `Edited ${filePath}`,
      metadata: {
        display: {
          summary: `Edited ${filePath}`,
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

export function replaceLiteralMatch(content: string, oldString: string, newString: string, index: number): string {
  return content.slice(0, index) + newString + content.slice(index + oldString.length)
}

export interface StringMatchContext {
  index: number
  line: number
  column: number
  context: string
}

export function findStringMatches(content: string, search: string): StringMatchContext[] {
  if (search.length === 0) {
    return []
  }

  const matches: StringMatchContext[] = []
  let index = content.indexOf(search)
  while (index !== -1) {
    matches.push(matchContext(content, index))
    index = content.indexOf(search, index + search.length)
  }
  return matches
}

export function multipleMatchFailure(oldString: string, matches: StringMatchContext[], label = 'oldString'): ToolResult {
  return {
    ok: false,
    content: formatMatchFailure(label, matches),
    errorCode: 'precondition_failed',
    errorDetails: {
      oldStringLength: oldString.length,
      occurrences: matches.length,
      matches: matches.slice(0, 5),
      truncated: matches.length > 5,
    },
  }
}

function matchContext(content: string, index: number): StringMatchContext {
  const before = content.slice(0, index)
  const line = before.split('\n').length
  const lastLineBreak = before.lastIndexOf('\n')
  const column = index - lastLineBreak

  const lines = content.split('\n')
  const startLine = Math.max(1, line - 2)
  const endLine = Math.min(lines.length, line + 2)
  const width = String(endLine).length
  const snippet = lines
    .slice(startLine - 1, endLine)
    .map((text, offset) => {
      const currentLine = startLine + offset
      const marker = currentLine === line ? '>' : ' '
      return `${marker} ${String(currentLine).padStart(width, ' ')} | ${text}`
    })
    .join('\n')

  return { index, line, column, context: snippet }
}

function formatMatchFailure(label: string, matches: StringMatchContext[]): string {
  const header = `Expected exactly one match for ${label}, found ${matches.length}.`
  if (matches.length === 0) {
    return header
  }

  const shown = matches.slice(0, 5)
  const sections = shown.map((match, offset) => [
    `Match ${offset + 1} at line ${match.line}, column ${match.column}:`,
    match.context,
  ].join('\n'))
  const truncated = matches.length > shown.length ? `\nShowing first ${shown.length} of ${matches.length} matches.` : ''
  return `${header}\n\n${sections.join('\n\n')}${truncated}`
}
