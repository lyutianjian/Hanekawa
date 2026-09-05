import fg from 'fast-glob'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'

interface GlobInput {
  pattern: string
  path?: string
}

export const globTool: Tool = {
  name: 'Glob',
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.{ts,tsx}". Returns paths relative to the search root. Use Grep to search file contents.',
  searchHint: 'find files by name pattern glob',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Glob pattern to match against file paths, e.g. "**/*.ts".'),
    path: z.string().min(1).optional().describe('Directory to search in. Defaults to the working directory.'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  userFacingName: () => 'Search',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const { pattern, path: searchPath } = input as { pattern?: unknown; path?: unknown }
    if (typeof pattern !== 'string') return null
    if (typeof searchPath === 'string' && searchPath.trim()) {
      return `pattern: "${truncateMiddle(pattern, 80)}", path: "${truncateMiddle(searchPath.trim(), 60)}"`
    }
    return `pattern: "${truncateMiddle(pattern, 100)}"`
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Searching files'
    const pattern = (input as { pattern?: unknown }).pattern
    return typeof pattern === 'string' ? `Searching ${truncateMiddle(pattern, 60)}` : 'Searching files'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as GlobInput
    const cwd = options.path ? assertInsideCwd(context.cwd, options.path) : context.cwd
    const entries = await fg(options.pattern, { cwd, dot: false })
    const count = entries.length
    return {
      ok: true,
      content: entries.join('\n') || 'No files found.',
      metadata: {
        display: {
          summary: count === 0
            ? 'No files found'
            : `Found ${count} ${count === 1 ? 'file' : 'files'}`,
        },
      },
    }
  },
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
