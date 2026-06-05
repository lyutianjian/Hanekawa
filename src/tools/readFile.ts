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
  description: 'Read a UTF-8 text file from the current project.',
  searchHint: 'read file contents view',
  inputSchema: z.object({
    filePath: z.string().min(1),
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
    const { filePath } = input as { filePath: string }
    const absolute = assertInsideCwd(context.cwd, filePath)

    // Block dangerous device paths
    if (isBlockedDevicePath(absolute)) {
      return {
        ok: false,
        content: `Cannot read '${filePath}': this device file would block or produce infinite output.`,
        errorCode: 'invalid_input',
      }
    }

    const content = await readFileAndRemember(absolute, context)
    const lineCount = countLines(content)
    return {
      ok: true,
      content,
      metadata: {
        display: {
          summary: `Read ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`,
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
