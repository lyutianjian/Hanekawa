import { mkdir, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { SessionStore } from '../../sessions/service.js'

const execFileAsync = promisify(execFile)

export interface Checkpoint {
  commitHash: string
  messageId: string
  messageContent: string
  timestamp: string
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

export class CheckpointService {
  private readonly shadowGitDir: string
  private readonly worktree: string
  private readonly sessionId: string
  private readonly cwd: string

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd
    this.sessionId = sessionId
    this.shadowGitDir = path.join(cwd, '.myagent', 'shadow-git', sessionId)
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
}
