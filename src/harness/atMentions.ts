import { stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fg from 'fast-glob'
import type { AtMentionContextRecord, AtMentionFileContext, ToolContext } from './types.js'
import { wrapInSystemReminder } from './systemReminder.js'
import { readFileAndRemember } from '../tools/fileState.js'
import { filterGitIgnoredPaths } from '../utils/gitIgnore.js'
import { assertInsideCwd } from '../utils/paths.js'
import { isProtectedPath } from '../utils/permissions/protectedPaths.js'

export const CODE_TEXT_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.scala',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
])

const MAX_AT_MENTION_FILES = 5
const MAX_ATTACHMENT_LINES = 2_000
const MAX_ATTACHMENT_BYTES = 80 * 1024
const IGNORED_DIR_NAMES = ['.git', '.myagent', 'node_modules', 'build', 'coverage']

export interface ParsedAtMention {
  raw: string
  filePath: string
  lineStart?: number
  lineEnd?: number
}

export function extractAtMentionedFiles(input: string): ParsedAtMention[] {
  const results: ParsedAtMention[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const parsed = parseAtMentionedFileLines(raw)
    const key = `${parsed.filePath}#${parsed.lineStart ?? ''}-${parsed.lineEnd ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ raw, ...parsed })
  }

  let match: RegExpExecArray | null
  const quoted = /(^|\s)@"([^"]+)"((?:#L\d+(?:-\d+)?)?)(?:#[^\s]*)?/g
  while ((match = quoted.exec(input)) !== null) {
    if (match[2]) add(`${match[2]}${match[3] ?? ''}`)
  }

  const regular = /(^|\s)@([^\s"]+)/g
  while ((match = regular.exec(input)) !== null) {
    const raw = match[2]
    if (raw) add(raw)
  }

  return results.slice(0, MAX_AT_MENTION_FILES)
}

export function parseAtMentionedFileLines(mention: string): {
  filePath: string
  lineStart?: number
  lineEnd?: number
} {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)
  if (!match) return { filePath: mention }

  const lineStart = match[2] ? Math.max(1, parseInt(match[2], 10)) : undefined
  const lineEnd = match[3] ? Math.max(lineStart ?? 1, parseInt(match[3], 10)) : lineStart
  return {
    filePath: match[1] ?? mention,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}

export async function buildAtMentionContextRecord(input: {
  userInput: string
  userMessageId: string
  turnId: string
  toolContext: ToolContext
  createdAt?: string
}): Promise<AtMentionContextRecord | undefined> {
  const attachments: Array<{ file: AtMentionFileContext; content: string }> = []

  for (const mention of extractAtMentionedFiles(input.userInput)) {
    const remaining = MAX_AT_MENTION_FILES - attachments.length
    if (remaining <= 0) break

    const mentionAttachments = await readAtMentionedCodeFiles(mention, input.toolContext, remaining)
    attachments.push(...mentionAttachments)
  }

  if (attachments.length === 0) return undefined

  const innerContent = [
    'User attached code files with @-mentions. Treat this as user-provided context for the current task.',
    ...attachments.map(({ file, content: fileContent }) => {
      const truncated = file.truncated ? ' truncated="true"' : ''
      return `<file path="${escapeAttribute(file.displayPath)}" lines="${file.lineStart}-${file.lineEnd}"${truncated}>\n${fileContent}\n</file>`
    }),
  ].join('\n\n')
  const content = wrapInSystemReminder(innerContent)

  return {
    id: `at-mention-${randomUUID()}`,
    type: 'at_mention_context',
    userMessageId: input.userMessageId,
    turnId: input.turnId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files: attachments.map((attachment) => attachment.file),
    content,
  }
}

async function readAtMentionedCodeFiles(
  mention: ParsedAtMention,
  toolContext: ToolContext,
  limit: number,
): Promise<Array<{ file: AtMentionFileContext; content: string }>> {
  const displayCandidate = mention.filePath
  if (isProtectedPath(displayCandidate)) return []

  let absolute: string
  try {
    absolute = assertInsideCwd(toolContext.cwd, displayCandidate)
  } catch {
    return []
  }

  const displayPath = normalizeDisplayPath(path.relative(toolContext.cwd, absolute))
  if (isProtectedPath(displayPath) || isProtectedPath(absolute)) return []

  let fileStat
  try {
    fileStat = await stat(absolute)
  } catch {
    return []
  }

  const ignorePath = fileStat.isDirectory() ? `${displayPath}/` : displayPath
  const visiblePaths = await filterGitIgnoredPaths(toolContext.cwd, [ignorePath])
  if (visiblePaths.length === 0) return []

  if (fileStat.isDirectory()) {
    return readAtMentionedCodeDirectory(absolute, displayPath, toolContext, limit)
  }

  if (!fileStat.isFile()) return []
  if (!CODE_TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return []

  const attachment = await readAtMentionedCodeFileAtPath(absolute, displayPath, mention, toolContext)
  return attachment ? [attachment] : []
}

async function readAtMentionedCodeDirectory(
  absoluteDir: string,
  displayPath: string,
  toolContext: ToolContext,
  limit: number,
): Promise<Array<{ file: AtMentionFileContext; content: string }>> {
  const extensions = [...CODE_TEXT_EXTENSIONS].map((ext) => ext.slice(1))
  let matches: string[]
  try {
    matches = await fg(`**/*.{${extensions.join(',')}}`, {
      cwd: absoluteDir,
      onlyFiles: true,
      dot: false,
      ignore: IGNORED_DIR_NAMES.map((dir) => `${dir}/**`),
      unique: true,
    })
  } catch {
    return []
  }

  const candidates = matches
    .map((entry) => normalizeDisplayPath(path.posix.join(displayPath, normalizeDisplayPath(entry))))
    .filter((entry) => !isProtectedPath(entry))
    .sort((a, b) => a.localeCompare(b))

  const visibleCandidates = await filterGitIgnoredPaths(toolContext.cwd, candidates)
  const attachments: Array<{ file: AtMentionFileContext; content: string }> = []
  for (const candidate of visibleCandidates.slice(0, limit)) {
    let absolute: string
    try {
      absolute = assertInsideCwd(toolContext.cwd, candidate)
    } catch {
      continue
    }

    const attachment = await readAtMentionedCodeFileAtPath(
      absolute,
      candidate,
      { raw: candidate, filePath: candidate },
      toolContext,
    )
    if (attachment) attachments.push(attachment)
  }

  return attachments
}

async function readAtMentionedCodeFileAtPath(
  absolute: string,
  displayPath: string,
  mention: ParsedAtMention,
  toolContext: ToolContext,
): Promise<{ file: AtMentionFileContext; content: string } | undefined> {
  let raw: string
  try {
    raw = await readFileAndRemember(absolute, toolContext)
  } catch {
    return undefined
  }

  if (raw.slice(0, 8192).includes('\0')) {
    toolContext.readFiles.delete(absolute)
    toolContext.readFileState?.delete(absolute)
    return undefined
  }

  const totalLines = countLines(raw)
  const requestedStart = mention.lineStart ?? 1
  const requestedEnd = mention.lineEnd ?? totalLines
  const lineStart = clampLine(requestedStart, totalLines)
  const lineEnd = Math.max(lineStart, clampLine(requestedEnd, totalLines))
  const sliced = sliceLines(raw, lineStart, lineEnd)
  const truncated = truncateAttachmentContent(sliced)

  return {
    file: {
      path: absolute,
      displayPath,
      lineStart,
      lineEnd: lineStart + truncated.includedLines - 1,
      truncated: truncated.truncated || lineEnd > lineStart + truncated.includedLines - 1,
    },
    content: truncated.content,
  }
}

function sliceLines(content: string, lineStart: number, lineEnd: number): string {
  const lines = content.split(/\r?\n/)
  return lines.slice(lineStart - 1, lineEnd).join('\n')
}

function truncateAttachmentContent(content: string): { content: string; truncated: boolean; includedLines: number } {
  const lines = content.split(/\r?\n/)
  let truncated = false
  let selected = lines
  if (selected.length > MAX_ATTACHMENT_LINES) {
    selected = selected.slice(0, MAX_ATTACHMENT_LINES)
    truncated = true
  }

  let text = selected.join('\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_ATTACHMENT_BYTES) {
    text = truncateUtf8(text, MAX_ATTACHMENT_BYTES)
    truncated = true
  }

  const includedLines = countLines(text)
  if (truncated) {
    text = `${text}\n\n[... @-mentioned file content truncated ...]`
  }
  return { content: text, truncated, includedLines }
}

function truncateUtf8(content: string, maxBytes: number): string {
  let used = 0
  let result = ''
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    result += char
  }
  return result
}

function countLines(content: string): number {
  if (content.length === 0) return 1
  return content.endsWith('\n')
    ? content.slice(0, -1).split(/\r?\n/).length
    : content.split(/\r?\n/).length
}

function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(1, line), Math.max(1, totalLines))
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
