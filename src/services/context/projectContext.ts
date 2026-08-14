import { readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import fg from 'fast-glob'

const CONTEXT_FILES = [
  'MYAGENT.md',
  'CLAUDE.md',
  'AGENTS.md',
]

const LOCAL_FILES = [
  'MYAGENT.local.md',
  'CLAUDE.local.md',
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function discoverContextFiles(cwd: string): Promise<string[]> {
  const found: string[] = []
  let dir = cwd
  const visited = new Set<string>()

  while (dir !== resolve(dir, '..') && !visited.has(dir)) {
    visited.add(dir)

    // Check for context files
    for (const name of CONTEXT_FILES) {
      const filePath = join(dir, name)
      if (await exists(filePath)) {
        found.push(filePath)
      }
    }

    // Check for rules directory
    const rulesDir = join(dir, '.myagent', 'rules')
    if (await exists(rulesDir)) {
      try {
        const ruleFiles = await fg('*.md', { cwd: rulesDir, absolute: true })
        found.push(...ruleFiles)
      } catch {
        // Ignore glob errors
      }
    }

    dir = resolve(dir, '..')
  }

  // Local files (highest priority, loaded last)
  for (const name of LOCAL_FILES) {
    const filePath = join(cwd, name)
    if (await exists(filePath)) {
      found.push(filePath)
    }
  }

  return found
}

export async function loadProjectContext(cwd: string): Promise<string> {
  const files = await discoverContextFiles(cwd)

  if (files.length === 0) return ''

  const contents = await Promise.all(
    files.map(async (f) => {
      try {
        return await readFile(f, 'utf-8')
      } catch {
        return ''
      }
    }),
  )

  const validContents = contents.filter((c) => c.trim().length > 0)
  if (validContents.length === 0) return ''

  return [
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
    '',
    ...validContents,
  ].join('\n')
}

// Project context per cwd. A single-slot cache thrashed once two projects were
// open at the same time, re-reading every CLAUDE.md on each alternating turn.
const contextByCwd = new Map<string, string>()

export async function getProjectContext(cwd: string): Promise<string> {
  const cached = contextByCwd.get(cwd)
  if (cached !== undefined) return cached

  const context = await loadProjectContext(cwd)
  contextByCwd.set(cwd, context)
  return context
}

export function clearProjectContextCache(cwd?: string): void {
  if (cwd === undefined) {
    contextByCwd.clear()
    return
  }
  contextByCwd.delete(cwd)
}
