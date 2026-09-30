import { readFile, access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import fg from 'fast-glob'
import { getUserInstructionsPath } from '../../utils/paths.js'

/**
 * The instruction file names, in preference order. Both lists are **first match
 * wins per directory**: a repo that keeps `AGENTS.md` and `CLAUDE.md` in sync
 * (this one does) would otherwise send the same guide twice in every request.
 */
const CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
]

const LOCAL_FILES = [
  'CLAUDE.local.md',
  'AGENTS.local.md',
]

/** The first of `names` that exists in `dir`, or undefined. */
async function firstExisting(dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const filePath = join(dir, name)
    if (await exists(filePath)) return filePath
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function discoverContextFiles(cwd: string): Promise<string[]> {
  // One entry per directory walked, cwd first. Emitted root-first below: the
  // walk goes upwards, but the prompt reads downwards, and the nearest file is
  // the most specific one, so it has to come last to override its ancestors.
  const byDirectory: string[][] = []
  let dir = cwd
  const visited = new Set<string>()

  while (dir !== resolve(dir, '..') && !visited.has(dir)) {
    visited.add(dir)
    const level: string[] = []

    // Check for context files
    const contextFile = await firstExisting(dir, CONTEXT_FILES)
    if (contextFile) level.push(contextFile)

    // Check for rules directory
    const rulesDir = join(dir, '.myagent', 'rules')
    if (await exists(rulesDir)) {
      try {
        const ruleFiles = await fg('*.md', { cwd: rulesDir, absolute: true })
        level.push(...ruleFiles)
      } catch {
        // Ignore glob errors
      }
    }

    byDirectory.push(level)
    dir = resolve(dir, '..')
  }

  const found = byDirectory.reverse().flat()

  // Local files (highest priority, loaded last)
  const localFile = await firstExisting(cwd, LOCAL_FILES)
  if (localFile) found.push(localFile)

  return found
}

export async function readUserInstructions(): Promise<string> {
  try {
    return await readFile(getUserInstructionsPath(), 'utf-8')
  } catch {
    return ''
  }
}

/** Blank content removes the file rather than leaving an empty one behind. */
export async function writeUserInstructions(content: string): Promise<void> {
  const path = getUserInstructionsPath()
  if (content.trim() === '') {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

export async function loadProjectContext(cwd: string): Promise<string> {
  const files = await discoverContextFiles(cwd)

  const entries: string[] = []
  const user = (await readUserInstructions()).trim()
  if (user !== '') {
    entries.push(labelled(getUserInstructionsPath(), "user's private global instructions for all projects", user))
  }
  for (const file of files) {
    let content = ''
    try {
      content = (await readFile(file, 'utf-8')).trim()
    } catch {}
    if (content === '') continue
    const description = /\.local\.md$/.test(file)
      ? "user's private project instructions, not checked in"
      : 'project instructions, checked into the codebase'
    entries.push(labelled(file, description, content))
  }
  if (entries.length === 0) return ''

  // The user's file and the project's are independent, not layers: each entry
  // says what it is and none is described as overriding another.
  return [
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
    ...entries,
  ].join('\n\n')
}

function labelled(path: string, description: string, content: string): string {
  return `Contents of ${path} (${description}):\n\n${content}`
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
