import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The current branch of a project directory, read straight off `.git/HEAD`.
 *
 * No `git` subprocess and no library: the desktop shell wants one string for a
 * read-only badge, and spawning a process per pane attach to learn it would cost
 * more than everything else `hello` does. `.git/HEAD` is a single line and its
 * format is part of git's on-disk contract.
 *
 * Deliberately narrow, in three ways:
 *
 * - It never walks up to a parent directory. The badge describes the project
 *   root; a parent repository's branch would be a lie about this project.
 * - It never throws. Not a repository, unreadable, a bare SHA — all of them are
 *   `undefined`, and the caller hides the badge. Nothing here may block an attach.
 * - A detached HEAD reports `undefined` rather than a short SHA. The slot means
 *   "which branch"; `a1b2c3d` in it reads as a branch named after a hash.
 *
 * Host-side only. It is not on `test/rendererImports.test.ts`'s allowlist, so it
 * cannot reach the renderer bundle.
 */

const REF_PREFIX = 'ref: refs/heads/'

/** `ref: refs/heads/<name>` → `<name>`. Everything else → `undefined`. */
export function parseGitHead(contents: string): string | undefined {
  const line = contents.trim()
  if (!line.startsWith(REF_PREFIX)) return undefined
  const name = line.slice(REF_PREFIX.length).trim()
  return name === '' ? undefined : name
}

/**
 * Best effort, and asynchronous on purpose: `execute()` is already async, and a
 * synchronous read would park the Electron main process on a disk that may be a
 * network share.
 *
 * A worktree or submodule has `.git` as a *file* (`gitdir: …`), so this read
 * fails with `ENOTDIR` — swallowed by the same catch. That is the whole handling
 * of that case: resolving the indirection would mean following a path out of the
 * project for a decorative badge.
 */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    return parseGitHead(await readFile(path.join(cwd, '.git', 'HEAD'), 'utf8'))
  } catch {
    return undefined
  }
}
