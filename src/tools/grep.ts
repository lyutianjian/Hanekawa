import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { assertInsideCwd } from '../utils/paths.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  headLimit?: number
}

const RG_TIMEOUT_MS = 30_000

/**
 * Try ripgrep first (ReDoS-immune, fast). Falls back to Node RegExp if
 * `rg` is not installed. The fallback applies a per-file timeout to
 * mitigate catastrophic backtracking.
 */
function tryRipgrep(
  pattern: string,
  root: string,
  glob: string | undefined,
  caseInsensitive: boolean,
  limit: number,
  cwd: string,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const args = ['--no-heading', '--line-number', '--max-count', String(limit)]
    if (caseInsensitive) args.push('--ignore-case')
    if (glob) args.push('--glob', glob)
    args.push('--', pattern, '.')

    const proc = execFile('rg', args, { cwd: root, timeout: RG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        // rg not found or other error — signal fallback
        resolve(null)
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      const matches = lines.map((line) => {
        // rg outputs relative paths from cwd
        const colonIdx = line.indexOf(':')
        const colonIdx2 = line.indexOf(':', colonIdx + 1)
        const relPath = line.substring(0, colonIdx)
        const lineNum = line.substring(colonIdx + 1, colonIdx2)
        const content = line.substring(colonIdx2 + 1)
        return `${path.relative(cwd, path.join(root, relPath))}:${lineNum}:${content}`
      })
      resolve(matches)
    })

    // Handle spawn errors (e.g., rg not found on Windows)
    proc.on('error', () => resolve(null))
  })
}

/**
 * Fallback: Node RegExp with per-file timeout to limit ReDoS impact.
 */
async function fallbackGrep(
  pattern: string,
  root: string,
  glob: string | undefined,
  caseInsensitive: boolean,
  limit: number,
  cwd: string,
): Promise<string[]> {
  const flags = caseInsensitive ? 'i' : ''
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return ['Error: Invalid regular expression pattern.']
  }

  const entries = await fg(glob ?? '**/*', { cwd: root, onlyFiles: true, dot: false })
  const matches: string[] = []

  for (const entry of entries) {
    if (matches.length >= limit) break
    const filePath = path.join(root, entry)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    // Skip binary files (check for null bytes in first 8KB)
    if (raw.slice(0, 8192).includes('\0')) continue

    const lines = raw.split('\n')
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0
      if (matches.length < limit && regex.test(line)) {
        matches.push(`${path.relative(cwd, filePath)}:${index + 1}: ${line}`)
      }
    }
  }

  return matches
}

export const grepTool: Tool = {
  name: 'Grep',
  description: 'Search text files for a regular expression pattern. Uses ripgrep when available for ReDoS-immune, fast searching.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    caseInsensitive: z.boolean().optional(),
    headLimit: z.number().int().min(1).max(10_000).optional(),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 30_000,
  async execute(input, context) {
    const options = input as GrepInput
    const root = assertInsideCwd(context.cwd, options.path ?? '.')
    const limit = options.headLimit ?? 50
    const caseInsensitive = options.caseInsensitive ?? false

    // Try ripgrep first (ReDoS-immune, faster)
    const rgMatches = await tryRipgrep(options.pattern, root, options.glob, caseInsensitive, limit, context.cwd)
    if (rgMatches !== null) {
      return { ok: true, content: rgMatches.join('\n') || 'No matches found.' }
    }

    // Fallback to Node RegExp
    const matches = await fallbackGrep(options.pattern, root, options.glob, caseInsensitive, limit, context.cwd)
    return { ok: true, content: matches.join('\n') || 'No matches found.' }
  },
}
