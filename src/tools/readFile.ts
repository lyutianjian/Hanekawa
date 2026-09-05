import { stat } from 'node:fs/promises'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'
import { readFileAndRemember } from './fileState.js'

// Block reads of device files that would hang or produce infinite output.
// On Windows these paths don't exist, so the check is a harmless no-op.
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console',
  '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/* and /proc/<pid>/fd/* patterns
  if (filePath.includes('/proc/') && filePath.includes('/fd/')) return true
  return false
}

export const readFileTool: Tool = {
  name: 'Read',
  description: [
    'Read a text file from the current project.',
    'Content is returned with `cat -n` style line numbers; the numbers are display only — never include them in an Edit oldString.',
    'CRLF files are normalized to LF on read, so a multi-line oldString written with \\n matches.',
    'Use offset/limit to page through a large file; a partial read still lets Edit match anywhere in the file.',
  ].join(' '),
  searchHint: 'read file contents view',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory.'),
    offset: z.number().int().min(1).optional().describe('1-based line number to start reading from. Defaults to 1.'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines to return. Defaults to the whole file.'),
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
    const { filePath, offset = 1, limit } = input as { filePath: string; offset?: number; limit?: number }
    const absolute = assertInsideCwd(context.cwd, filePath)

    // Block dangerous device paths
    if (isBlockedDevicePath(absolute)) {
      return {
        ok: false,
        content: `Cannot read '${filePath}': this device file would block or produce infinite output.`,
        errorCode: 'invalid_input',
      }
    }

    // The full file is always remembered, even for a windowed read: Edit
    // matches against the remembered content, so a partial view must not
    // narrow what a later edit can address.
    const content = await readFileAndRemember(absolute, context)
    const totalLines = countLines(content)

    const window = sliceLines(content, offset, limit)
    if (window.lines.length === 0 && totalLines > 0) {
      return {
        ok: false,
        content: `Cannot read '${filePath}' from line ${window.start}: the file has only ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}.`,
        errorCode: 'invalid_input',
      }
    }

    const body = numberLines(window.lines, window.start)
    const truncated = window.start > 1 || window.end < totalLines
    const notice = truncated
      ? `\n\n[Showing lines ${window.start}-${window.end} of ${totalLines}. Use offset/limit to read another range.]`
      : ''

    return {
      ok: true,
      content: body + notice,
      metadata: {
        display: {
          summary: truncated
            ? `Read lines ${window.start}-${window.end} of ${totalLines}`
            : `Read ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`,
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

function sliceLines(content: string, offset: number, limit: number | undefined): { lines: string[]; start: number; end: number } {
  const all = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  if (content.length === 0) return { lines: [], start: 1, end: 0 }
  const start = Math.max(1, offset)
  const lines = all.slice(start - 1, limit === undefined ? undefined : start - 1 + limit)
  return { lines, start, end: start + lines.length - 1 }
}

const LINE_NUMBER_WIDTH = 6

function numberLines(lines: string[], start: number): string {
  return lines
    .map((line, index) => `${String(start + index).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`)
    .join('\n')
}
