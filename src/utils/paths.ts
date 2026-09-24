import path from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
}

/**
 * User-level `.myagent`, shared by every project. Resolved lazily through
 * `homedir()` so tests can redirect it via USERPROFILE/HOME.
 */
export function getGlobalMyAgentDir(): string {
  return path.join(homedir(), '.myagent')
}

/**
 * Where a project's runtime data lives: sessions, spilled tool output, image
 * attachments, plans. Under the user's `~/.myagent/projects/` rather than the
 * project's own `.myagent/`, so opening a folder leaves nothing behind in it —
 * `<cwd>/.myagent/` is for the configuration a user put there themselves.
 *
 * Keyed by the resolved path, so a renamed or moved project starts with an
 * empty history; its old data stays under the old key.
 */
export function getProjectDataDir(cwd: string): string {
  return path.join(getGlobalMyAgentDir(), 'projects', projectDataKey(cwd))
}

/**
 * A readable directory name for a project root, e.g. `/Users/me/code/foo` →
 * `Users-me-code-foo-1a2b3c4d`. The hash keeps `/a/b-c` and `/a/b/c` apart
 * (both flatten to the same name); case is folded first on the platforms whose
 * filesystems are case-insensitive, like `projectRootKey`.
 */
export function projectDataKey(cwd: string): string {
  const root = normalizeCaseForComparison(path.resolve(cwd))
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8)
  const readable = root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80)
  return readable ? `${readable}-${hash}` : hash
}

/**
 * Whether `cwd` is the user's home directory — the workspace sessions fall
 * back to when no project is open (the 全局/「最近」 workspace, whose records
 * are keyed by the home directory under `~/.myagent/projects/`).
 *
 * Case-insensitive on the platforms whose filesystems are, the same discipline
 * `projectRootKey` compares roots with: a home directory reached through a
 * different-but-equivalent casing is still the global workspace.
 */
export function isGlobalWorkspaceRoot(cwd: string): boolean {
  return normalizeCaseForComparison(path.resolve(cwd)) === normalizeCaseForComparison(path.resolve(homedir()))
}

const MAX_PATH_DEPTH = 50
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin'

const resolvedCwdCache = new Map<string, string>()

export function invalidateResolvedCwdCache(cwd?: string): void {
  if (cwd) {
    resolvedCwdCache.delete(cwd)
    return
  }
  resolvedCwdCache.clear()
}

export function normalizeCaseForComparison(filePath: string): string {
  return CASE_INSENSITIVE_PLATFORM ? filePath.toLowerCase() : filePath
}

function withTrailingSeparator(filePath: string): string {
  return filePath.endsWith(path.sep) ? filePath : filePath + path.sep
}

function relativeSegments(from: string, to: string): string[] {
  const relative = path.relative(from, to)
  return relative === '' ? [] : relative.split(path.sep)
}

function resolveExistingPrefix(absolute: string): string {
  try {
    return realpathSync(absolute)
  } catch {
    // The target may be new; resolve the deepest existing ancestor instead.
  }

  let probe = absolute
  const missing: string[] = []
  while (true) {
    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new Error(`Unable to resolve path ancestor for "${absolute}"`)
    }

    missing.unshift(path.basename(probe))
    probe = parent

    try {
      return path.join(realpathSync(probe), ...missing)
    } catch {
      // Keep walking upward until an existing ancestor is found.
    }
  }
}

/**
 * Resolves a user-supplied path against cwd and throws if the result
 * escapes the cwd boundary. Follows symlinks before comparing.
 */
export function assertInsideCwd(cwd: string, filePath: string): string {
  const absolute = path.resolve(cwd, filePath)

  let resolvedCwd = resolvedCwdCache.get(cwd)
  if (!resolvedCwd) {
    resolvedCwd = realpathSync(cwd)
    resolvedCwdCache.set(cwd, resolvedCwd)
  }

  const resolvedAbsolute = resolveExistingPrefix(absolute)
  const comparableAbsolute = normalizeCaseForComparison(resolvedAbsolute)
  const comparableCwd = normalizeCaseForComparison(resolvedCwd)

  if (!withTrailingSeparator(comparableAbsolute).startsWith(withTrailingSeparator(comparableCwd)) && comparableAbsolute !== comparableCwd) {
    throw new Error(`Path "${filePath}" resolves outside the working directory`)
  }

  const depth = relativeSegments(resolvedCwd, resolvedAbsolute).length
  if (depth > MAX_PATH_DEPTH) {
    throw new Error(`Path "${filePath}" exceeds maximum depth of ${MAX_PATH_DEPTH}`)
  }

  return absolute
}

export function getConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'config.json')
}

/** Base config layer shared across projects; `getConfigPath` overrides it. */
export function getGlobalConfigPath(): string {
  return path.join(getGlobalMyAgentDir(), 'config.json')
}

export function getMcpConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'mcp.json')
}

export function getSessionsDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'sessions')
}

/**
 * Where a session spills tool output too large to send inline. The model gets
 * a preview plus this path, so the rest stays reachable with a Read.
 */
export function getToolResultSpillDir(cwd: string, sessionId: string): string {
  return path.join(getProjectDataDir(cwd), 'tool-results', sessionId)
}

/** Where plan mode writes its plan files. See `utils/plans.ts`. */
export function getProjectPlansDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'plans')
}

/**
 * The file tools' path guard: `assertInsideCwd`, plus the two places outside
 * the project the model is *told* to use — this session's spilled tool output
 * (the preview hands it the path to Read) and the project's plan files (plan
 * mode has it Write them). Nothing else under `~/.myagent` is reachable, the
 * session transcripts least of all.
 */
export function resolveToolPath(context: { cwd: string; sessionId?: string }, filePath: string): string {
  try {
    return assertInsideCwd(context.cwd, filePath)
  } catch (error) {
    const absolute = path.resolve(context.cwd, filePath)
    const roots = [getProjectPlansDir(context.cwd)]
    if (context.sessionId) roots.push(getToolResultSpillDir(context.cwd, context.sessionId))
    for (const root of roots) {
      if (isUnderRoot(root, absolute)) return absolute
    }
    throw error
  }
}

function isUnderRoot(root: string, absolute: string): boolean {
  let a: string
  let r: string
  try {
    a = normalizeCaseForComparison(resolveExistingPrefix(absolute))
    r = normalizeCaseForComparison(resolveExistingPrefix(path.resolve(root)))
  } catch {
    return false
  }
  return withTrailingSeparator(a).startsWith(withTrailingSeparator(r))
}

export function getSkillsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'skills')
}

export function getAgentsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'agents')
}

export function getLocalAgentsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'agents.local')
}
