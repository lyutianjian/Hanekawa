import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
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
  offset?: number
  multiline?: boolean
}

const RG_TIMEOUT_MS = 30_000
const DEFAULT_HEAD_LIMIT = 250
/** Version control metadata is noise in every search anyone actually runs. */
const VCS_EXCLUSIONS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
/** Keeps a minified or base64 line from swallowing the whole result budget. */
const MAX_COLUMNS = 500

/**
 * Try ripgrep first (ReDoS-immune, fast). Resolves `null` — and only `null` —
 * when `rg` could not be run at all, which is the signal to fall back.
 *
 * Ripgrep exits 1 when it simply found nothing. Treating that as "rg missing"
 * sent every empty search through a full-tree fast-glob scan, which is both
 * slow and how raw `fs` errors reached the model.
 */
function tryRipgrep(
  pattern: string,
  target: string,
  glob: string | undefined,
  caseInsensitive: boolean,
  cwd: string,
  multiline: boolean = false,
): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    // `-H` because ripgrep drops the filename when given exactly one file, and
    // every consumer here parses `path:line:text`.
    const args = ['--no-heading', '--line-number', '-H', '--hidden', '--max-columns', String(MAX_COLUMNS)]
    for (const dir of VCS_EXCLUSIONS) args.push('--glob', `!${dir}`)
    if (caseInsensitive) args.push('--ignore-case')
    if (multiline) args.push('-U', '--multiline-dotall')
    if (glob) args.push('--glob', glob)
    // A pattern starting with `-` would otherwise be read as a flag.
    args.push('-e', pattern, '--', target)

    let spawnFailed = false
    const proc = execFile('rg', args, { cwd, timeout: RG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (spawnFailed) return
      const exitCode = typeof (err as { code?: unknown } | null)?.code === 'number'
        ? (err as unknown as { code: number }).code
        : undefined
      if (err && exitCode === undefined) {
        // Killed by signal or timed out — not something a fallback can fix.
        reject(err)
        return
      }
      if (exitCode !== undefined && exitCode >= 2) {
        reject(new Error(`ripgrep failed (exit ${exitCode}): ${String(stderr).trim() || 'unknown error'}`))
        return
      }
      // exit 0 = matches, exit 1 = no matches. Both are answers.
      resolve(toRelativeMatches(stdout, cwd))
    })

    // Spawn errors (rg not installed) are the one fallback-worthy case.
    proc.on('error', () => {
      spawnFailed = true
      resolve(null)
    })
  })
}

/**
 * Ripgrep prints `path:line:text`. On Windows an absolute path starts with a
 * drive letter, so the first colon belongs to `C:` and splitting on it turns
 * every path into the single character "C".
 */
function splitRgLine(line: string): { filePath: string; rest: string } | null {
  const driveOffset = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0
  const colonIdx = line.indexOf(':', driveOffset)
  if (colonIdx === -1) return null
  return { filePath: line.substring(0, colonIdx), rest: line.substring(colonIdx) }
}

function toRelativeMatches(stdout: string, cwd: string): string[] {
  const lines = stdout.split('\n').filter(Boolean)
  return lines.map((line) => {
    const parts = splitRgLine(line)
    if (!parts) return line
    return path.relative(cwd, path.resolve(cwd, parts.filePath)) + parts.rest
  })
}

/**
 * Fallback: Node RegExp with per-file timeout to limit ReDoS impact.
 * `files` is the explicit file list; a single-file target skips globbing.
 */
async function fallbackGrep(
  pattern: string,
  target: string,
  targetIsFile: boolean,
  glob: string | undefined,
  caseInsensitive: boolean,
  limit: number,
  cwd: string,
  multiline: boolean = false,
): Promise<string[]> {
  const flags = (caseInsensitive ? 'i' : '') + (multiline ? 's' : '')
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return ['Error: Invalid regular expression pattern.']
  }

  const files = targetIsFile
    ? [target]
    : (await fg(glob ?? '**/*', { cwd: target, onlyFiles: true, dot: false })).map((entry) => path.join(target, entry))
  const matches: string[] = []

  for (const filePath of files) {
    if (matches.length >= limit) break
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
  description: [
    'Search file contents for a regular expression. Uses ripgrep when available, with a Node RegExp fallback.',
    'Results are `path:line:text`. Version control directories are excluded automatically.',
    'Use headLimit/offset to paginate and multiline for patterns that span lines.',
  ].join(' '),
  searchHint: 'search file contents with regex (ripgrep)',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Regular expression to search for (ripgrep syntax).'),
    path: z.string().min(1).optional().describe('File or directory to search in. Defaults to the working directory. A single file is searched directly.'),
    glob: z.string().min(1).optional().describe('Glob filtering which files are searched, e.g. "*.ts". Ignored when path is a file.'),
    caseInsensitive: z.boolean().optional().describe('Case-insensitive search. Defaults to false.'),
    headLimit: z.number().int().min(0).max(10_000).optional().describe('Maximum matches to return. Defaults to 250; 0 means unlimited.'),
    offset: z.number().int().min(0).optional().describe('Skip this many matches before applying headLimit. Defaults to 0.'),
    multiline: z.boolean().optional().describe('Let the pattern span lines and let `.` match newlines. Defaults to false.'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 30_000,
  userFacingName: () => 'Search',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const { pattern, path: searchPath, glob, offset } = input as { pattern?: unknown; path?: unknown; glob?: unknown; offset?: unknown }
    if (typeof pattern !== 'string') return null
    const parts = [`pattern: "${truncateMiddle(pattern, 80)}"`]
    if (typeof searchPath === 'string' && searchPath.trim()) parts.push(`path: "${truncateMiddle(searchPath.trim(), 60)}"`)
    if (typeof glob === 'string' && glob.trim()) parts.push(`glob: "${truncateMiddle(glob.trim(), 60)}"`)
    if (typeof offset === 'number' && offset > 0) parts.push(`offset: ${offset}`)
    return parts.join(', ')
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Searching files'
    const pattern = (input as { pattern?: unknown }).pattern
    return typeof pattern === 'string' ? `Searching for "${truncateMiddle(pattern, 60)}"` : 'Searching files'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as GrepInput
    const target = assertInsideCwd(context.cwd, options.path ?? '.')
    const caseInsensitive = options.caseInsensitive ?? false
    const multiline = options.multiline ?? false
    const offset = options.offset ?? 0
    // headLimit: 0 means unlimited; undefined means use default
    const effectiveLimit = options.headLimit === 0 ? Infinity : (options.headLimit ?? DEFAULT_HEAD_LIMIT)
    // Fetch enough results to cover offset + limit
    const fetchLimit = effectiveLimit === Infinity ? 10_000 : offset + effectiveLimit

    // `path` may name a file. Resolving that here keeps ripgrep from being
    // handed a file as its working directory, and keeps fast-glob from calling
    // scandir on one — both of which surfaced as a bare ENOTDIR.
    let targetIsFile: boolean
    try {
      targetIsFile = (await stat(target)).isFile()
    } catch {
      return {
        ok: false,
        content: `Cannot search '${options.path ?? '.'}': the path does not exist. Relative paths resolve against ${context.cwd}. Use Glob to locate the file first.`,
        errorCode: 'not_found',
      }
    }

    // Try ripgrep first (ReDoS-immune, faster)
    const rgMatches = await tryRipgrep(options.pattern, target, targetIsFile ? undefined : options.glob, caseInsensitive, context.cwd, multiline)
    if (rgMatches !== null) {
      return paginateResult(rgMatches, effectiveLimit, offset)
    }

    // Fallback to Node RegExp
    const matches = await fallbackGrep(options.pattern, target, targetIsFile, options.glob, caseInsensitive, fetchLimit, context.cwd, multiline)
    return paginateResult(matches, effectiveLimit, offset)
  },
}

function paginateResult(allMatches: string[], limit: number, offset: number) {
  const sliced = allMatches.slice(offset, offset + limit)
  const matchCount = sliced.length
  const fileCount = new Set(sliced.map((m) => m.split(':', 1)[0]).filter(Boolean)).size

  let content = sliced.join('\n') || 'No matches found.'
  // Append pagination notice if results were truncated
  if (offset > 0 || sliced.length < allMatches.length) {
    content += `\n\n[Showing results ${offset + 1}..${offset + sliced.length} of ${allMatches.length} total matches]`
  }

  return {
    ok: true,
    content,
    metadata: {
      display: {
        summary: matchCount === 0
          ? 'No matches found'
          : `Found ${matchCount} ${matchCount === 1 ? 'match' : 'matches'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
      },
    },
  }
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
