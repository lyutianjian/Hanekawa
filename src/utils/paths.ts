import path from 'node:path'
import { realpathSync } from 'node:fs'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
}

const MAX_PATH_DEPTH = 50

const resolvedCwdCache = new Map<string, string>()

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

  let resolvedAbsolute: string
  try {
    resolvedAbsolute = realpathSync(absolute)
  } catch {
    // File may not exist yet (writeFile) — validate the raw resolved path
    resolvedAbsolute = path.resolve(absolute)
  }

  const withSep = (p: string) => p.endsWith(path.sep) ? p : p + path.sep
  if (!withSep(resolvedAbsolute).startsWith(withSep(resolvedCwd)) && resolvedAbsolute !== resolvedCwd) {
    throw new Error(`Path "${filePath}" resolves outside the working directory`)
  }

  const depth = absolute.split(path.sep).length - resolvedCwd.split(path.sep).length
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
