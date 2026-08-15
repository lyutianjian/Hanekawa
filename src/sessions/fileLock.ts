import { hostname } from 'node:os'
import { open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * Advisory cross-process lock for the session files.
 *
 * `SessionStore`'s promise-chain mutexes are static fields, so they serialize
 * writers inside one process and do nothing at all between two. That was fine
 * while the CLI was the only writer; a desktop app open on the same project
 * makes it a real interleaving hazard, and `index.json` is the file two
 * processes corrupt first.
 *
 * Implemented with `O_EXCL` rather than `flock`, which is not portable and is a
 * no-op on some Windows filesystems. The cost is that a crashed holder leaves
 * the file behind, so a lock is stealable once it is both older than `staleMs`
 * and owned by a pid that is no longer alive.
 */

export interface FileLockOptions {
  /** A lock older than this whose owner is gone may be stolen. */
  staleMs?: number
  /** Give up and run anyway rather than block forever. */
  timeoutMs?: number
}

interface LockOwner {
  pid: number
  host: string
  acquiredAt: number
}

const DEFAULT_STALE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const POLL_MIN_MS = 5
const POLL_MAX_MS = 50

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const acquired = await acquire(lockPath, staleMs, timeoutMs)
  try {
    return await operation()
  } finally {
    if (acquired) await release(lockPath)
  }
}

/**
 * Returns whether the lock is actually held. A false return means we timed out
 * and are proceeding anyway: blocking a session write forever because some
 * other process is wedged is worse than the interleaving we are guarding
 * against, and every writer underneath is either an append or a tmp+rename.
 */
async function acquire(lockPath: string, staleMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let delay = POLL_MIN_MS

  await mkdir(dirname(lockPath), { recursive: true })

  for (;;) {
    if (await tryCreate(lockPath)) return true
    if (await stealIfStale(lockPath, staleMs)) continue
    if (Date.now() >= deadline) return false
    await sleep(delay)
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx', 0o600)
    const owner: LockOwner = { pid: process.pid, host: hostname(), acquiredAt: Date.now() }
    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    // A lock we cannot create at all (read-only dir, permissions) must not stop
    // the write it was guarding.
    return false
  }
}

/** Removes a lock whose holder is demonstrably gone. */
async function stealIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await stat(lockPath)
    if (Date.now() - stats.mtimeMs < staleMs) return false

    const owner = await readOwner(lockPath)
    // Only steal from a dead pid on this machine. A lock held from another host
    // (a network share) can never be verified, so age alone has to do.
    if (owner && owner.host === hostname() && isAlive(owner.pid)) return false

    await unlink(lockPath)
    return true
  } catch {
    return false
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as LockOwner
    return typeof parsed?.pid === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function release(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch {
    // Already stolen or removed; nothing to do.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
