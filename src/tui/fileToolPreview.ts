import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assertInsideCwd } from '../utils/paths.js'

type ReadFile = (absolutePath: string) => string | undefined

interface PreviewOptions {
  cwd?: string
  readFile?: ReadFile
}

export interface FileToolDiffPreview {
  kind: 'diff'
  title: string
  filePath: string
  oldText: string
  newText: string
  summary: string
}

export interface FileToolMessagePreview {
  kind: 'message'
  title: string
  filePath?: string
  message: string
}

export type FileToolPreview = FileToolDiffPreview | FileToolMessagePreview

interface EditItem {
  oldString: string
  newString: string
}

interface ResolvedEdit extends EditItem {
  index: number
  start: number
  end: number
}

export function buildFileToolPreview(
  toolName: string,
  input: unknown,
  options: PreviewOptions = {},
): FileToolPreview | undefined {
  if (!isRecord(input)) return undefined

  const filePath = typeof input.filePath === 'string' ? input.filePath : undefined
  if (!filePath) return undefined

  const cwd = options.cwd ?? process.cwd()
  let absolute: string
  try {
    absolute = assertInsideCwd(cwd, filePath)
  } catch (error) {
    return {
      kind: 'message',
      title: `${toolName} preview unavailable`,
      filePath,
      message: error instanceof Error ? error.message : 'Unable to resolve file path.',
    }
  }

  const readFile = options.readFile ?? defaultReadFile
  if (toolName === 'Write') {
    return buildWritePreview(input, filePath, absolute, readFile)
  }
  if (toolName === 'Edit') {
    return buildEditPreview(input, filePath, absolute, readFile)
  }
  if (toolName === 'MultiEdit') {
    return buildMultiEditPreview(input, filePath, absolute, readFile)
  }
  if (toolName === 'Delete') {
    return buildDeletePreview(filePath, absolute, readFile)
  }
  return undefined
}

function buildWritePreview(
  input: Record<string, unknown>,
  filePath: string,
  absolute: string,
  readFile: ReadFile,
): FileToolPreview {
  if (typeof input.content !== 'string') {
    return messagePreview('Write preview unavailable', filePath, 'Missing string content.')
  }
  const oldText = readFile(absolute)
  const exists = oldText !== undefined
  return {
    kind: 'diff',
    title: exists ? 'Overwrite file' : 'Create file',
    filePath,
    oldText: oldText ?? '',
    newText: input.content,
    summary: exists
      ? `${relativeLabel(filePath)} will be overwritten`
      : `${relativeLabel(filePath)} will be created`,
  }
}

function buildEditPreview(
  input: Record<string, unknown>,
  filePath: string,
  absolute: string,
  readFile: ReadFile,
): FileToolPreview {
  const edit = parseEdit(input)
  if (!edit) {
    return messagePreview('Edit preview unavailable', filePath, 'Missing oldString or newString.')
  }

  const original = readFile(absolute)
  if (original === undefined) {
    return messagePreview('Edit preview unavailable', filePath, 'File content is not available for preview.')
  }

  const matches = findLiteralMatches(original, edit.oldString)
  if (matches.length !== 1) {
    return messagePreview(
      'Edit preview unavailable',
      filePath,
      `Expected exactly one match for oldString, found ${matches.length}.`,
    )
  }

  return {
    kind: 'diff',
    title: 'Edit file',
    filePath,
    oldText: original,
    newText: replaceAt(original, edit.oldString, edit.newString, matches[0]!),
    summary: `${relativeLabel(filePath)} will be edited`,
  }
}

function buildMultiEditPreview(
  input: Record<string, unknown>,
  filePath: string,
  absolute: string,
  readFile: ReadFile,
): FileToolPreview {
  if (!Array.isArray(input.edits)) {
    return messagePreview('MultiEdit preview unavailable', filePath, 'Missing edits array.')
  }

  const edits: EditItem[] = []
  for (const [index, item] of input.edits.entries()) {
    if (!isRecord(item) || typeof item.oldString !== 'string' || typeof item.newString !== 'string') {
      return messagePreview('MultiEdit preview unavailable', filePath, `edits[${index}] is invalid.`)
    }
    edits.push({ oldString: item.oldString, newString: item.newString })
  }

  const original = readFile(absolute)
  if (original === undefined) {
    return messagePreview('MultiEdit preview unavailable', filePath, 'File content is not available for preview.')
  }

  const resolved: ResolvedEdit[] = []
  for (const [index, edit] of edits.entries()) {
    const matches = findLiteralMatches(original, edit.oldString)
    if (matches.length !== 1) {
      return messagePreview(
        'MultiEdit preview unavailable',
        filePath,
        `Expected exactly one match for edits[${index}].oldString, found ${matches.length}.`,
      )
    }
    const start = matches[0]!
    resolved.push({ ...edit, index, start, end: start + edit.oldString.length })
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!
      const b = resolved[j]!
      if (a.start < b.end && b.start < a.end) {
        return messagePreview(
          'MultiEdit preview unavailable',
          filePath,
          `Overlapping edits: edits[${a.index}] overlaps with edits[${b.index}].`,
        )
      }
    }
  }

  let nextText = original
  for (const edit of [...resolved].sort((a, b) => b.start - a.start)) {
    nextText = replaceAt(nextText, edit.oldString, edit.newString, edit.start)
  }

  return {
    kind: 'diff',
    title: 'Edit file',
    filePath,
    oldText: original,
    newText: nextText,
    summary: `${relativeLabel(filePath)} will receive ${edits.length} edit${edits.length === 1 ? '' : 's'}`,
  }
}

function buildDeletePreview(filePath: string, absolute: string, readFile: ReadFile): FileToolPreview {
  const oldText = readFile(absolute)
  if (oldText === undefined) {
    return messagePreview('Delete preview unavailable', filePath, 'File content is not available for preview.')
  }
  return {
    kind: 'diff',
    title: 'Delete file',
    filePath,
    oldText,
    newText: '',
    summary: `${relativeLabel(filePath)} will be deleted`,
  }
}

function defaultReadFile(absolutePath: string): string | undefined {
  if (!existsSync(absolutePath)) return undefined
  try {
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

function parseEdit(input: Record<string, unknown>): EditItem | undefined {
  if (typeof input.oldString !== 'string' || typeof input.newString !== 'string') {
    return undefined
  }
  return { oldString: input.oldString, newString: input.newString }
}

function findLiteralMatches(content: string, search: string): number[] {
  if (search.length === 0) return []
  const matches: number[] = []
  let index = content.indexOf(search)
  while (index !== -1) {
    matches.push(index)
    index = content.indexOf(search, index + search.length)
  }
  return matches
}

function replaceAt(content: string, oldString: string, newString: string, index: number): string {
  return content.slice(0, index) + newString + content.slice(index + oldString.length)
}

function messagePreview(title: string, filePath: string, message: string): FileToolMessagePreview {
  return { kind: 'message', title, filePath, message }
}

function relativeLabel(filePath: string): string {
  return path.normalize(filePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
