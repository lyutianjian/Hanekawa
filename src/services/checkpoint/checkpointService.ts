import { mkdir, access, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { SessionStore, assertSafeSessionId } from '../../sessions/service.js'
import { getMyAgentDir } from '../../utils/paths.js'

const execFileAsync = promisify(execFile)

export interface Checkpoint {
  commitHash: string
  messageId: string
  messageContent: string
  timestamp: string
}

export interface CheckpointDiffSummary {
  fileCount: number
  additions: number
  deletions: number
  firstFile?: string
  hasChanges: boolean
}

export interface CheckpointWithDiff extends Checkpoint {
  turnDiff: CheckpointDiffSummary
  restoreDiff: CheckpointDiffSummary
  isCurrent: boolean
}

export interface CheckpointCreateResult {
  success: boolean
  commitHash?: string
  error?: string
  reusedPrevious?: boolean
}

export interface CheckpointMapping {
  messageId: string
  commitHash: string
  createdAt: string
}

/**
 * Where a session's shadow repo lives. The only place that knows that layout,
 * so deleting a session and snapshotting one cannot disagree about the path.
 * `.myagent` itself comes from `getMyAgentDir` — `utils/paths.ts` owns that
 * literal, and every other `.myagent` path already routes through it.
 */
export function shadowRepoPath(cwd: string, sessionId: string): string {
  return path.join(getMyAgentDir(cwd), 'shadow-git', sessionId)
}

/**
 * Deletes a session's shadow repo. Called when a session itself is deleted —
 * until this existed the repo outlived every other trace of the session and
 * leaked for the life of the project.
 *
 * The guard is load-bearing rather than defensive: the caller's `sessionId`
 * comes off the wire (`delete-session`) and lands in an `rm` with
 * `recursive: true`, one bad argument away from `.myagent/shadow-git` itself.
 * It is `SessionStore`'s own validator so the two cannot drift, and callers pass
 * the id the store *resolved*, never a prefix.
 */
export async function removeShadowRepo(cwd: string, sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId)
  await rm(shadowRepoPath(cwd, sessionId), { recursive: true, force: true })
}

export class CheckpointService {
  private readonly shadowGitDir: string
  private readonly worktree: string
  private readonly sessionId: string
  private readonly cwd: string

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd
    this.sessionId = sessionId
    this.shadowGitDir = shadowRepoPath(cwd, sessionId)
    this.worktree = cwd
  }

  /**
   * Initialize shadow git repo for a new session.
   * Creates a bare-like repo under .myagent/shadow-git/<session-id>/
   * with the worktree set to the project root.
   */
  async init(): Promise<void> {
    try {
      await mkdir(this.shadowGitDir, { recursive: true })

      // Initialize a new git repo
      await this.git(['init'])

      // Configure the worktree to point at the project root
      await this.git(['config', 'core.worktree', this.worktree])

      // Configure user for commits
      await this.git(['config', 'user.email', 'snapshots@hanekawa.local'])
      await this.git(['config', 'user.name', 'Hanekawa'])

      // Disable symlinks and set safe defaults for Windows compatibility
      await this.git(['config', 'core.symlinks', 'false'])
      await this.git(['config', 'core.autocrlf', 'false'])
      await this.git(['config', 'core.safecrlf', 'false'])
    } catch (error) {
      throw new Error(`Failed to initialize shadow git repo: ${(error as Error).message}`)
    }
  }

  /**
   * Create a checkpoint commit before agent processing.
   * Stages all files (respecting .gitignore), commits, and returns the hash.
   * If no changes exist, reuses the previous commit hash.
   */
  async createCheckpoint(messageId: string): Promise<CheckpointCreateResult> {
    try {
      // Stage all files, respecting .gitignore
      await this.git(['add', '--all'])

      // Check if there are staged changes
      const hasChanges = await this.hasStagedChanges()

      if (!hasChanges) {
        // No changes — reuse previous commit hash
        const previousHash = await this.getLastCommitHash()
        if (previousHash) {
          return {
            success: true,
            commitHash: previousHash,
            reusedPrevious: true,
          }
        }
        // No previous commit exists either — create an initial empty commit
        await this.git(['commit', '--allow-empty', '-m', `checkpoint: ${messageId}`])
      } else {
        // Commit the staged changes
        await this.git(['commit', '-m', `checkpoint: ${messageId}`])
      }

      const commitHash = await this.getLastCommitHash()
      if (!commitHash) {
        return { success: false, error: 'Failed to retrieve commit hash after commit' }
      }

      return { success: true, commitHash }
    } catch (error) {
      return {
        success: false,
        error: `Checkpoint creation failed: ${(error as Error).message}`,
      }
    }
  }

  /**
   * Get all checkpoints for the current session from session metadata.
   * Loads session records to populate messageContent for each checkpoint.
   */
  async getCheckpoints(): Promise<Checkpoint[]> {
    try {
      const store = new SessionStore(this.cwd)
      await store.init()
      const mappings = await store.getCheckpointMappings(this.sessionId)
      if (mappings.length === 0) return []

      const records = await store.loadRecords(this.sessionId)
      const messageContentMap = new Map<string, string>()
      for (const record of records) {
        if (record.type === 'message' && record.role === 'user') {
          messageContentMap.set(record.id, record.content)
        }
      }

      return mappings.map((mapping) => ({
        commitHash: mapping.commitHash,
        messageId: mapping.messageId,
        messageContent: messageContentMap.get(mapping.messageId) ?? '',
        timestamp: mapping.createdAt,
      }))
    } catch {
      return []
    }
  }

  /**
   * Get checkpoints enriched with code-change summaries for rewind UI.
   *
   * `turnDiff` describes the work after that prompt until the next checkpoint,
   * or the current worktree for the latest prompt. `restoreDiff` describes
   * everything that would change if code were restored to this checkpoint.
   */
  async getCheckpointsWithDiffs(): Promise<CheckpointWithDiff[]> {
    const checkpoints = await this.getCheckpoints()
    const chronological = [...checkpoints].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )

    const byMessageId = new Map<string, CheckpointWithDiff>()
    for (let index = 0; index < chronological.length; index++) {
      const checkpoint = chronological[index]
      if (!checkpoint) continue
      const next = chronological[index + 1]
      const turnDiff = next
        ? await this.getDiffBetweenCommits(checkpoint.commitHash, next.commitHash)
        : await this.getDiffFromCommitToWorktree(checkpoint.commitHash)
      const restoreDiff = await this.getDiffFromCommitToWorktree(checkpoint.commitHash)
      byMessageId.set(checkpoint.messageId, {
        ...checkpoint,
        turnDiff,
        restoreDiff,
        isCurrent: index === chronological.length - 1,
      })
    }

    return checkpoints.map((checkpoint) => byMessageId.get(checkpoint.messageId)).filter((entry): entry is CheckpointWithDiff => Boolean(entry))
  }

  async getDiffBetweenCommits(fromCommitHash: string, toCommitHash: string): Promise<CheckpointDiffSummary> {
    if (fromCommitHash === toCommitHash) return emptyDiffSummary()
    const output = await this.git(['diff', '--numstat', fromCommitHash, toCommitHash, '--', '.'])
    return parseNumstat(output)
  }

  async getDiffFromCommitToWorktree(commitHash: string): Promise<CheckpointDiffSummary> {
    const tracked = parseNumstat(await this.git(['diff', '--numstat', commitHash, '--', '.']))
    const untracked = await this.getUntrackedDiffSummary()
    return mergeDiffSummaries(tracked, untracked)
  }

  /**
   * Restore working tree to a specific checkpoint commit.
   * Uses git checkout to restore file state.
   */
  async restoreToCommit(commitHash: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Force checkout the commit to restore working tree
      await this.git(['checkout', commitHash, '--', '.'])
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: `Failed to restore to commit ${commitHash}: ${(error as Error).message}`,
      }
    }
  }

  /**
   * Check if shadow git repo exists and is valid.
   */
  async isInitialized(): Promise<boolean> {
    try {
      const headPath = path.join(this.shadowGitDir, 'HEAD')
      await access(headPath)
      // Verify it's a valid git repo by running a simple command
      await this.git(['status', '--porcelain'])
      return true
    } catch {
      return false
    }
  }

  /**
   * Execute a git command in the shadow git repo.
   *
   * The command runs with cwd set to the worktree (project root) so that
   * pathspec resolution (e.g. `.` in `git checkout <hash> -- .`) is consistent
   * with the worktree. GIT_DIR points git at the shadow repo, and
   * GIT_WORK_TREE confirms the worktree explicitly. Running with cwd inside
   * the GIT_DIR causes inconsistent index/tree state on Windows, so we avoid
   * that pattern here.
   */
  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.worktree,
      env: {
        ...process.env,
        GIT_DIR: this.shadowGitDir,
        GIT_WORK_TREE: this.worktree,
      },
      timeout: 30000,
    })
    return stdout.trim()
  }

  /**
   * Check if there are staged changes ready to commit.
   */
  private async hasStagedChanges(): Promise<boolean> {
    try {
      const output = await this.git(['diff', '--cached', '--name-only'])
      return output.length > 0
    } catch {
      // If diff fails (e.g., no HEAD yet), check if index has entries
      try {
        await this.git(['rev-parse', 'HEAD'])
        return false
      } catch {
        // No HEAD means this is the first commit — there are staged changes if index is non-empty
        const output = await this.git(['ls-files', '--cached'])
        return output.length > 0
      }
    }
  }

  /**
   * Get the hash of the last commit, or null if no commits exist.
   */
  private async getLastCommitHash(): Promise<string | null> {
    try {
      const hash = await this.git(['rev-parse', 'HEAD'])
      return hash || null
    } catch {
      return null
    }
  }

  private async getUntrackedDiffSummary(): Promise<CheckpointDiffSummary> {
    const output = await this.git(['ls-files', '--others', '--exclude-standard', '--', '.'])
    const files = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (files.length === 0) return emptyDiffSummary()

    let additions = 0
    for (const file of files) {
      additions += await countFileLines(path.join(this.worktree, file))
    }

    return {
      fileCount: files.length,
      additions,
      deletions: 0,
      firstFile: files[0],
      hasChanges: true,
    }
  }
}

function emptyDiffSummary(): CheckpointDiffSummary {
  return {
    fileCount: 0,
    additions: 0,
    deletions: 0,
    hasChanges: false,
  }
}

function parseNumstat(output: string): CheckpointDiffSummary {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return emptyDiffSummary()

  let additions = 0
  let deletions = 0
  let firstFile: string | undefined
  for (const line of lines) {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split(/\s+/)
    additions += parseCount(rawAdditions)
    deletions += parseCount(rawDeletions)
    firstFile ??= pathParts.join(' ')
  }

  return {
    fileCount: lines.length,
    additions,
    deletions,
    ...(firstFile ? { firstFile } : {}),
    hasChanges: lines.length > 0,
  }
}

function parseCount(value: string | undefined): number {
  if (!value || value === '-') return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeDiffSummaries(...summaries: CheckpointDiffSummary[]): CheckpointDiffSummary {
  const changed = summaries.filter((summary) => summary.hasChanges)
  if (changed.length === 0) return emptyDiffSummary()
  return {
    fileCount: summaries.reduce((sum, summary) => sum + summary.fileCount, 0),
    additions: summaries.reduce((sum, summary) => sum + summary.additions, 0),
    deletions: summaries.reduce((sum, summary) => sum + summary.deletions, 0),
    firstFile: changed[0]?.firstFile,
    hasChanges: true,
  }
}

async function countFileLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf8')
    if (content.length === 0) return 0
    return content.endsWith('\n') ? content.split(/\r?\n/).length - 1 : content.split(/\r?\n/).length
  } catch {
    return 0
  }
}
