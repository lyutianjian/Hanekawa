import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readGitBranch } from './gitBranch.js'

/**
 * The local branches of a project directory, and switching between them.
 *
 * The sibling of `gitBranch.ts`, and deliberately not folded into it: that one
 * reads a single line off `.git/HEAD` because it runs on *every* attach, and a
 * subprocess per attach would cost more than everything else `hello` does. These
 * two run only when the user opens the empty state's branch popover, so they can
 * afford `git` itself — and they must, because neither the branch list nor a
 * checkout is a file that can be read.
 *
 * `execFile`, never a shell: the branch name comes off the wire, and the whole
 * point of passing an argv array is that no quoting rule stands between it and
 * git. {@link isSafeBranchName} is the second half of that — argv keeps a name
 * from becoming a command, and the check keeps it from becoming a *flag*.
 *
 * Host-side only. Not on `test/rendererImports.test.ts`'s allowlist, so it
 * cannot reach the renderer bundle.
 */

const execFileAsync = promisify(execFile)

/** Long enough for a cold index on a network share, short enough to give up. */
const GIT_TIMEOUT_MS = 15000

export interface GitBranchList {
  /** Local branches, most recently committed first. Empty when git said nothing. */
  readonly branches: readonly string[]
  /** The checked-out branch, absent on a detached HEAD or outside a repository. */
  readonly current?: string
}

export interface GitSwitchResult {
  readonly ok: boolean
  /** Where HEAD ended up — read back rather than assumed, even on failure. */
  readonly current?: string
  /** git's own words, for the failure note. Absent when `ok`. */
  readonly message?: string
}

/**
 * Whether a name may be handed to git at all.
 *
 * A leading `-` is the one that matters: argv stops a name from being a second
 * command, but `--force` in the name slot is still a flag. The rest —
 * whitespace, control characters, git's own reserved sequences — are rejected
 * because a legal branch name contains none of them, so anything that does is
 * either a bug upstream or an attempt.
 */
export function isSafeBranchName(name: string): boolean {
  if (name === '' || name.length > 255) return false
  if (name.startsWith('-')) return false
  if (/[\s~^:?*[\\]/.test(name)) return false
  // Control characters, spelled by code point rather than as a range: a literal
  // NUL in this file would make it a binary blob to every tool that reads it.
  if ([...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    return false
  }
  return !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('/')
}

/**
 * Local branches only.
 *
 * No remotes: the row means "switch to this", and picking `origin/topic` would
 * silently create a tracking branch — a different act than the one the popover
 * offers. Sorted by commit date rather than alphabetically because the branches
 * a user switches between are the ones they touched last.
 *
 * Never throws. Not a repository, no git on PATH, a timeout — all of them are an
 * empty list, and the popover says so.
 */
export async function listGitBranches(cwd: string): Promise<GitBranchList> {
  const current = await readGitBranch(cwd)
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--list', '--format=%(refname:short)', '--sort=-committerdate'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    )
    const branches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return { branches, ...(current ? { current } : {}) }
  } catch {
    return { branches: [], ...(current ? { current } : {}) }
  }
}

/**
 * `git switch`, not `git checkout`: checkout also takes paths, so a name that
 * happened to match a file would restore that file instead of moving HEAD.
 *
 * A refused switch — a dirty worktree, a branch that does not exist — is a
 * result, not an exception: the caller draws git's own sentence, which says more
 * than any message this module could invent. HEAD is read back either way, so a
 * failure still reports where the user actually is.
 */
export async function switchGitBranch(cwd: string, branch: string): Promise<GitSwitchResult> {
  if (!isSafeBranchName(branch)) {
    return { ok: false, message: `无效的分支名：${branch}` }
  }
  try {
    await execFileAsync('git', ['switch', '--', branch], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    const current = await readGitBranch(cwd)
    return { ok: true, ...(current ? { current } : {}) }
  } catch (error) {
    const current = await readGitBranch(cwd)
    return { ok: false, ...(current ? { current } : {}), message: describeGitFailure(error) }
  }
}

/**
 * git writes the useful half to stderr — "Your local changes would be
 * overwritten" and the file list under it. `Error.message` from `execFile` is
 * the command line and the exit code, which tells the user nothing.
 */
function describeGitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}
