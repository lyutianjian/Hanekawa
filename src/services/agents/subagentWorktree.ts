import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { access, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const WORKTREE_SUMMARY_LIMIT_CHARS = 6_000

export type SubagentIsolation = 'worktree'

export interface SubagentWorktreeLease {
  isolation: 'worktree'
  path: string
  baseRef: string
}

export interface SubagentWorktreeManager {
  getPath(input: {
    cwd: string
    parentSessionId: string
    agentId: string
  }): string
  create(input: {
    cwd: string
    parentSessionId: string
    agentId: string
  }): Promise<SubagentWorktreeLease>
  summarize(input: {
    worktreePath: string
  }): Promise<string>
  exists(input: {
    worktreePath: string
  }): Promise<boolean>
  inspect(input: {
    worktreePath: string
  }): Promise<SubagentWorktreeInspection>
  cleanup(input: {
    cwd: string
    worktreePath: string
  }): Promise<SubagentWorktreeCleanupResult>
}

export interface SubagentWorktreeInspection {
  exists: boolean
  worktreePath: string
  summary?: string
}

export interface SubagentWorktreeCleanupResult {
  removed: boolean
  worktreePath: string
}

export class GitSubagentWorktreeManager implements SubagentWorktreeManager {
  getPath(input: { cwd: string; parentSessionId: string; agentId: string }): string {
    return path.join(
      tmpdir(),
      'hanekawa-subagent-worktrees',
      cwdKey(input.cwd),
      sanitizePathSegment(input.parentSessionId),
      sanitizePathSegment(input.agentId),
    )
  }

  async create(input: { cwd: string; parentSessionId: string; agentId: string }): Promise<SubagentWorktreeLease> {
    const repoRoot = await git(input.cwd, ['rev-parse', '--show-toplevel'])
    const baseRef = await git(input.cwd, ['rev-parse', '--verify', 'HEAD'])
    const worktreePath = this.getPath(input)
    await mkdir(path.dirname(worktreePath), { recursive: true })
    await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseRef])
    return {
      isolation: 'worktree',
      path: worktreePath,
      baseRef,
    }
  }

  async summarize(input: { worktreePath: string }): Promise<string> {
    const status = await git(input.worktreePath, ['status', '--short'])
    const unstagedStat = await git(input.worktreePath, ['diff', '--stat', '--'])
    const stagedStat = await git(input.worktreePath, ['diff', '--cached', '--stat', '--'])
    const sections = [
      status ? `Status:\n${status}` : undefined,
      unstagedStat ? `Unstaged diff stat:\n${unstagedStat}` : undefined,
      stagedStat ? `Staged diff stat:\n${stagedStat}` : undefined,
    ].filter((section): section is string => Boolean(section))
    const summary = sections.length > 0 ? sections.join('\n\n') : 'No changes.'
    return truncate(summary, WORKTREE_SUMMARY_LIMIT_CHARS)
  }

  async exists(input: { worktreePath: string }): Promise<boolean> {
    assertInWorktreeRoot(input.worktreePath)
    try {
      await access(input.worktreePath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async inspect(input: { worktreePath: string }): Promise<SubagentWorktreeInspection> {
    const exists = await this.exists(input)
    if (!exists) {
      return {
        exists: false,
        worktreePath: input.worktreePath,
      }
    }

    return {
      exists: true,
      worktreePath: input.worktreePath,
      summary: await this.summarize(input),
    }
  }

  async cleanup(input: { cwd: string; worktreePath: string }): Promise<SubagentWorktreeCleanupResult> {
    assertInWorktreeRoot(input.worktreePath)
    if (!(await this.exists(input))) {
      return {
        removed: false,
        worktreePath: input.worktreePath,
      }
    }

    try {
      await git(input.cwd, ['worktree', 'remove', '--force', input.worktreePath])
    } catch {
      await rm(input.worktreePath, { recursive: true, force: true })
    }

    return {
      removed: true,
      worktreePath: input.worktreePath,
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  })
  return stdout.trim()
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}

function cwdKey(cwd: string): string {
  const digest = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)
  return `${sanitizePathSegment(path.basename(cwd))}-${digest}`
}

function assertInWorktreeRoot(worktreePath: string): void {
  const root = path.resolve(tmpdir(), 'hanekawa-subagent-worktrees')
  const target = path.resolve(worktreePath)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside subagent worktree root: ${worktreePath}`)
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n\n[Worktree summary truncated: exceeded ${maxLength} chars; original ${value.length} chars]`
}
