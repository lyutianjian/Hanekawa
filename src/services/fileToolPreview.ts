import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { assertInsideCwd } from '../utils/paths.js'

/**
 * Returned by a reader that located the file but refused to load it. Distinct
 * from `undefined` (which means "not there") because `Write` infers whether it
 * is creating or overwriting from exactly that difference.
 */
export const PREVIEW_CONTENT_TOO_LARGE = Symbol('preview-content-too-large')

export type ReadFileResult = string | undefined | typeof PREVIEW_CONTENT_TOO_LARGE
export type ReadFile = (absolutePath: string) => ReadFileResult

export interface PreviewOptions {
  cwd?: string
  readFile?: ReadFile
}

/** Beyond this the file is never read; the preview degrades to a message. */
export const PREVIEW_MAX_FILE_BYTES = 2_000_000

export interface FileToolPreviewLimits {
  /** Combined budget across both sides of the diff. */
  maxChars: number
  /** Per-side line budget. */
  maxLines: number
}

/**
 * What a preview may cost to ship to a UI. The dialog only renders ~18 lines,
 * so these are transport limits, not display limits.
 */
export const PERMISSION_PREVIEW_LIMITS: FileToolPreviewLimits = {
  maxChars: 64_000,
  maxLines: 200,
}

export interface FileToolDiffPreview {
  kind: 'diff'
  title: string
  filePath: string
  oldText: string
  newText: string
  summary: string
  /** Set when `capFileToolPreview` dropped lines. Counts the *dropped* lines. */
  elided?: { oldLines: number; newLines: number }
}

export interface FileToolMessagePreview {
  kind: 'message'
  title: string
  filePath?: string
  message: string
}

export type FileToolPreview = FileToolDiffPreview | FileToolMessagePreview

const TOO_LARGE_MESSAGE = 'File is too large to preview.'

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
  if (oldText === PREVIEW_CONTENT_TOO_LARGE) {
    return messagePreview('Write preview unavailable', filePath, TOO_LARGE_MESSAGE)
  }
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
  if (original === PREVIEW_CONTENT_TOO_LARGE) {
    return messagePreview('Edit preview unavailable', filePath, TOO_LARGE_MESSAGE)
  }
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
  if (original === PREVIEW_CONTENT_TOO_LARGE) {
    return messagePreview('MultiEdit preview unavailable', filePath, TOO_LARGE_MESSAGE)
  }
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
  if (oldText === PREVIEW_CONTENT_TOO_LARGE) {
    return messagePreview('Delete preview unavailable', filePath, TOO_LARGE_MESSAGE)
  }
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

function defaultReadFile(absolutePath: string): ReadFileResult {
  let size: number
  try {
    const stats = statSync(absolutePath)
    if (!stats.isFile()) return undefined
    size = stats.size
  } catch {
    return undefined
  }
  // Checked before reading: a permission prompt must not pull a 500 MB file
  // into the host's heap only to decide it is undisplayable.
  if (size > PREVIEW_MAX_FILE_BYTES) return PREVIEW_CONTENT_TOO_LARGE
  try {
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Bounds what a diff preview costs to ship. Two different answers by design:
 * line-structured files are truncated (a 500-line edit keeps its diff), while
 * files with no line breaks to cut on degrade to a message rather than sending
 * megabytes for an 18-line dialog.
 *
 * Previews already inside both budgets are returned by identity — that is the
 * common case and it must not allocate.
 */
export function capFileToolPreview(
  preview: FileToolPreview,
  limits: FileToolPreviewLimits = PERMISSION_PREVIEW_LIMITS,
): FileToolPreview {
  if (preview.kind !== 'diff') return preview
  if (
    preview.oldText.length + preview.newText.length <= limits.maxChars
    && countLines(preview.oldText) <= limits.maxLines
    && countLines(preview.newText) <= limits.maxLines
  ) {
    return preview
  }

  const perSide = Math.floor(limits.maxChars / 2)
  const oldSide = capPreviewSide(preview.oldText, limits.maxLines, perSide)
  const newSide = capPreviewSide(preview.newText, limits.maxLines, perSide)

  if (oldSide.text.length + newSide.text.length > limits.maxChars) {
    return {
      kind: 'message',
      title: preview.title,
      filePath: preview.filePath,
      message: `Preview omitted: the file is too large to display (${formatPreviewSize(
        Math.max(preview.oldText.length, preview.newText.length),
      )}).`,
    }
  }

  return {
    ...preview,
    oldText: oldSide.text,
    newText: newSide.text,
    elided: { oldLines: oldSide.dropped, newLines: newSide.dropped },
  }
}

function capPreviewSide(
  text: string,
  maxLines: number,
  maxChars: number,
): { text: string; dropped: number } {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  let dropped = lines.length - kept.length

  let out = kept.join('\n')
  if (out.length > maxChars) {
    // Only ever cut on a line boundary: half a line fed to a word diff renders
    // as a bogus edit. With no boundary to cut on the side is left intact and
    // the caller degrades the whole preview to a message.
    const cut = out.lastIndexOf('\n', maxChars)
    if (cut > 0) {
      const trimmed = out.slice(0, cut)
      dropped += kept.length - countLines(trimmed)
      out = trimmed
    }
  }

  return { text: out, dropped }
}

function countLines(text: string): number {
  return text.split('\n').length
}

function formatPreviewSize(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`
  if (chars >= 1_000) return `${Math.round(chars / 1_000)} KB`
  return `${chars} B`
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
