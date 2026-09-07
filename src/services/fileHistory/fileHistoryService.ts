import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { diffLines } from 'diff'
import { getGlobalMyAgentDir } from '../../utils/paths.js'
import type { CheckpointDiffSummary } from '../checkpoint/checkpointService.js'

/** `null` means the file did not exist in that version. */
export type BackupFileName = string | null

export interface FileBackup {
  backupFileName: BackupFileName
  version: number
  /** ISO string rather than a `Date` so a backup survives JSONL round-trips. */
  backupTime: string
}

export interface FileHistorySnapshot {
  /** The user message this snapshot belongs to; how `/rewind` addresses it. */
  messageId: string
  /** Keyed by path relative to `cwd`; paths outside `cwd` stay absolute. */
  trackedFileBackups: Record<string, FileBackup>
  timestamp: string
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  /**
   * Monotonic, unlike `snapshots.length`, which plateaus once `maxSnapshots`
   * evicts from the front — so this is the only usable activity signal.
   */
  snapshotSequence: number
}

export interface FileHistoryLimits {
  maxSnapshots: number
}

export const DEFAULT_FILE_HISTORY_LIMITS: FileHistoryLimits = {
  maxSnapshots: 100,
}

/**
 * Where a session's backups live. Global rather than `<cwd>/.myagent/` so the
 * history never sits inside the tree it describes — the shadow-git predecessor
 * did, and grew recursively.
 */
export function fileHistoryDir(sessionId: string): string {
  return path.join(getGlobalMyAgentDir(), 'file-history', sessionId)
}

/**
 * Per-session, per-file backups of everything the agent's write tools touch.
 *
 * Replaces the shadow-git checkpoints: cost is proportional to the number of
 * files the agent edited, not to the size of the worktree, so no root is too
 * large to snapshot. The trade is that changes this process did not make —
 * hand edits, build output, unrecognised shell writes — are neither captured
 * nor restored.
 */
export class FileHistoryService {
  private readonly cwd: string
  private readonly sessionId: string
  private readonly limits: FileHistoryLimits
  private readonly backupDir: string
  private state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  private disposed = false

  constructor(cwd: string, sessionId: string, limits: FileHistoryLimits = DEFAULT_FILE_HISTORY_LIMITS) {
    this.cwd = cwd
    this.sessionId = sessionId
    this.limits = limits
    this.backupDir = fileHistoryDir(sessionId)
  }

  /** Rebuilds in-memory state. Persistence lands in a later task; empty for now. */
  async init(): Promise<void> {
    this.state = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  }

  dispose(): void {
    this.disposed = true
  }

  listSnapshots(): FileHistorySnapshot[] {
    return this.state.snapshots
  }

  /**
   * Backs up a file's *current* contents before a write tool changes it, so
   * the version attached to the in-flight snapshot is the pre-edit one.
   *
   * Split into read / backup / commit so a second call for the same path (two
   * edits in one turn) cannot overwrite `@v1` with post-edit content.
   */
  async trackEdit(filePath: string): Promise<void> {
    if (this.disposed) return
    const trackingPath = this.shortenPath(filePath)
    const current = this.state.snapshots.at(-1)
    // Nothing to attach a backup to yet: the turn's snapshot is what owns v1.
    if (!current) return
    if (current.trackedFileBackups[trackingPath]) return

    let backup: FileBackup
    try {
      backup = await this.createBackup(this.expandPath(trackingPath), 1)
    } catch {
      return
    }

    // Another trackEdit for the same path may have committed while we copied.
    const latest = this.state.snapshots.at(-1)
    if (!latest || latest.trackedFileBackups[trackingPath]) return
    latest.trackedFileBackups[trackingPath] = backup
    this.state.trackedFiles.add(trackingPath)
  }

  /**
   * Opens a new snapshot for `messageId`, carrying every tracked file forward
   * at the version it currently holds on disk. Unchanged files reuse the
   * previous backup, so a file the agent stopped touching costs one copy total.
   */
  async makeSnapshot(messageId: string): Promise<void> {
    if (this.disposed) return
    const previous = this.state.snapshots.at(-1)
    const trackedFileBackups: Record<string, FileBackup> = {}

    if (previous) {
      await Promise.all(
        Array.from(this.state.trackedFiles, async (trackingPath) => {
          try {
            const filePath = this.expandPath(trackingPath)
            const latestBackup = previous.trackedFileBackups[trackingPath]
            const nextVersion = latestBackup ? latestBackup.version + 1 : 1

            const stats = await statOrNull(filePath)
            if (!stats) {
              trackedFileBackups[trackingPath] = {
                backupFileName: null,
                version: nextVersion,
                backupTime: new Date().toISOString(),
              }
              return
            }

            if (
              latestBackup &&
              latestBackup.backupFileName !== null &&
              !(await this.hasFileChanged(filePath, latestBackup.backupFileName, stats))
            ) {
              trackedFileBackups[trackingPath] = latestBackup
              return
            }

            trackedFileBackups[trackingPath] = await this.createBackup(filePath, nextVersion)
          } catch {
            // A single unreadable file must not cost the whole snapshot.
          }
        }),
      )
    }

    // Re-read tracked files: a trackEdit may have landed while we were copying,
    // and its backup lives on the previous snapshot.
    const last = this.state.snapshots.at(-1)
    if (last) {
      for (const trackingPath of this.state.trackedFiles) {
        if (trackingPath in trackedFileBackups) continue
        const inherited = last.trackedFileBackups[trackingPath]
        if (inherited) trackedFileBackups[trackingPath] = inherited
      }
    }

    this.state.snapshots.push({
      messageId,
      trackedFileBackups,
      timestamp: new Date().toISOString(),
    })
    if (this.state.snapshots.length > this.limits.maxSnapshots) {
      this.state.snapshots = this.state.snapshots.slice(-this.limits.maxSnapshots)
    }
    this.state.snapshotSequence += 1
  }

  /**
   * Restores every tracked file to the version the snapshot for `messageId`
   * holds. Files that already match are left alone, and a file that did not
   * exist then is deleted. One file failing does not stop the rest.
   */
  async rewindTo(messageId: string): Promise<{ success: boolean; error?: string }> {
    const target = this.findSnapshot(messageId)
    if (!target) return { success: false, error: 'The selected snapshot was not found' }

    for (const trackingPath of this.state.trackedFiles) {
      try {
        const filePath = this.expandPath(trackingPath)
        const backupFileName = this.resolveBackupFileName(trackingPath, target)
        if (backupFileName === undefined) continue

        if (backupFileName === null) {
          try {
            await unlink(filePath)
          } catch (error) {
            if (!isENOENT(error)) throw error
          }
          continue
        }

        if (await this.hasFileChanged(filePath, backupFileName)) {
          await this.restoreBackup(filePath, backupFileName)
        }
      } catch {
        // Best effort per file: a locked or vanished file must not abort the rewind.
      }
    }

    return { success: true }
  }

  /** Would rewinding to `messageId` touch anything? Early-exits; never diffs. */
  async hasAnyChanges(messageId: string): Promise<boolean> {
    const target = this.findSnapshot(messageId)
    if (!target) return false

    for (const trackingPath of this.state.trackedFiles) {
      try {
        const filePath = this.expandPath(trackingPath)
        const backupFileName = this.resolveBackupFileName(trackingPath, target)
        if (backupFileName === undefined) continue
        if (backupFileName === null) {
          if (await statOrNull(filePath)) return true
          continue
        }
        if (await this.hasFileChanged(filePath, backupFileName)) return true
      } catch {
        // Treated as "no evidence of change"; the rewind itself is still safe.
      }
    }
    return false
  }

  /** Line counts for what a rewind to `messageId` would change, for the panel. */
  async getDiffStats(messageId: string): Promise<CheckpointDiffSummary> {
    const target = this.findSnapshot(messageId)
    if (!target) return emptyDiffSummary()

    const changed: string[] = []
    let additions = 0
    let deletions = 0

    for (const trackingPath of this.state.trackedFiles) {
      try {
        const filePath = this.expandPath(trackingPath)
        const backupFileName = this.resolveBackupFileName(trackingPath, target)
        if (backupFileName === undefined) continue

        const currentContent = await readFileOrNull(filePath)
        const backupContent =
          backupFileName === null ? null : await readFileOrNull(path.join(this.backupDir, backupFileName))
        if (currentContent === null && backupContent === null) continue

        let fileAdditions = 0
        let fileDeletions = 0
        for (const part of diffLines(currentContent ?? '', backupContent ?? '')) {
          if (part.added) fileAdditions += part.count ?? 0
          if (part.removed) fileDeletions += part.count ?? 0
        }
        if (fileAdditions === 0 && fileDeletions === 0) continue

        changed.push(trackingPath)
        additions += fileAdditions
        deletions += fileDeletions
      } catch {
        // Skip files we cannot read; the summary is advisory.
      }
    }

    if (changed.length === 0) return emptyDiffSummary()
    return {
      fileCount: changed.length,
      additions,
      deletions,
      ...(changed[0] ? { firstFile: changed[0] } : {}),
      hasChanges: true,
    }
  }

  /** Latest snapshot for a message id. ( is past this target's lib.) */
  private findSnapshot(messageId: string): FileHistorySnapshot | undefined {
    for (let index = this.state.snapshots.length - 1; index >= 0; index--) {
      const snapshot = this.state.snapshots[index]
      if (snapshot?.messageId === messageId) return snapshot
    }
    return undefined
  }

  /**
   * The backup to restore for a file the target snapshot may predate. A file
   * first tracked *after* that snapshot falls back to its v1 backup, which is
   * its pre-agent state — including "did not exist".
   */
  private resolveBackupFileName(
    trackingPath: string,
    snapshot: FileHistorySnapshot,
  ): BackupFileName | undefined {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (backup) return backup.backupFileName
    for (const candidate of this.state.snapshots) {
      const first = candidate.trackedFileBackups[trackingPath]
      if (first && first.version === 1) return first.backupFileName
    }
    return undefined
  }

  /**
   * Three tiers, cheapest first: mode/size, then "original older than the
   * backup ⇒ unchanged", and only then a content read.
   */
  private async hasFileChanged(
    filePath: string,
    backupFileName: string,
    originalStatsHint?: Stats,
  ): Promise<boolean> {
    const backupPath = path.join(this.backupDir, backupFileName)
    const originalStats = originalStatsHint ?? (await statOrNull(filePath))
    const backupStats = await statOrNull(backupPath)

    if ((originalStats === null) !== (backupStats === null)) return true
    if (originalStats === null || backupStats === null) return false
    if (originalStats.mode !== backupStats.mode || originalStats.size !== backupStats.size) return true
    if (originalStats.mtimeMs < backupStats.mtimeMs) return false

    const [originalContent, backupContent] = await Promise.all([
      readFileOrNull(filePath),
      readFileOrNull(backupPath),
    ])
    if (originalContent === null || backupContent === null) return true
    return originalContent !== backupContent
  }

  /**
   * Copies the file aside. `copyFile` rather than read+write: the latter puts
   * the whole file on the JS heap, which large tracked files do not survive.
   * The backup directory is created lazily — almost every call already has it.
   */
  private async createBackup(filePath: string, version: number): Promise<FileBackup> {
    const backupTime = new Date().toISOString()
    const stats = await statOrNull(filePath)
    if (!stats) return { backupFileName: null, version, backupTime }

    const backupFileName = backupNameFor(filePath, version)
    const backupPath = path.join(this.backupDir, backupFileName)
    try {
      await copyFile(filePath, backupPath)
    } catch (error) {
      if (!isENOENT(error)) throw error
      await mkdir(this.backupDir, { recursive: true })
      await copyFile(filePath, backupPath)
    }
    await chmod(backupPath, stats.mode)

    return { backupFileName, version, backupTime }
  }

  private async restoreBackup(filePath: string, backupFileName: string): Promise<void> {
    const backupPath = path.join(this.backupDir, backupFileName)
    // A missing backup means restoring would write nothing useful; leaving the
    // file alone beats truncating it.
    const backupStats = await statOrNull(backupPath)
    if (!backupStats) return

    try {
      await copyFile(backupPath, filePath)
    } catch (error) {
      if (!isENOENT(error)) throw error
      await mkdir(path.dirname(filePath), { recursive: true })
      await copyFile(backupPath, filePath)
    }
    await chmod(filePath, backupStats.mode)
  }

  /** Keys stay relative to `cwd` so the persisted history is compact. */
  private shortenPath(filePath: string): string {
    if (!path.isAbsolute(filePath)) return filePath
    const relative = path.relative(this.cwd, filePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return filePath
    return relative
  }

  private expandPath(trackingPath: string): string {
    return path.isAbsolute(trackingPath) ? trackingPath : path.join(this.cwd, trackingPath)
  }
}

/**
 * Hashes the *absolute* path, so the same file cannot end up with two backup
 * families depending on how the caller spelled it.
 */
function backupNameFor(absolutePath: string, version: number): string {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 16)
  return `${hash}@v${version}`
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

function emptyDiffSummary(): CheckpointDiffSummary {
  return { fileCount: 0, additions: 0, deletions: 0, hasChanges: false }
}
