import path from 'node:path'
import { realpathSync } from 'node:fs'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
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

export function getMcpConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'mcp.json')
}

export function getSessionsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'sessions')
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
