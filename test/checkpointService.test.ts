import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { CheckpointService } from '../src/services/checkpoint/checkpointService.js'
import { writeJsonFile } from '../src/utils/json.js'
import { getSessionsDir } from '../src/utils/paths.js'

const execFileAsync = promisify(execFile)

/**
 * Unit tests for CheckpointService.
 *
 * These tests exercise REAL git operations against an isolated temp directory
 * created with `mkdtemp`. They require `git` to be installed on the system —
 * if git is not available, the entire suite is skipped gracefully.
 *
 * Each test uses its own temp directory so tests do not interfere with each
 * other or with the surrounding project.
 */

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Create an isolated temp cwd for a test.
 *
 * IMPORTANT: We write a `.gitignore` that excludes `.myagent/`, mirroring the
 * project's own `.gitignore`. The CheckpointService stores its shadow git repo
 * under `.myagent/shadow-git/<session-id>/`, which is INSIDE the worktree.
 * Without this exclusion, `git add --all` would stage the shadow git's own
 * internal files (objects, refs, index), making every "no-change" checkpoint
 * appear to have changes and breaking the previous-commit reuse logic
 * (Requirement 5.4) and clean restores (Requirement 5.5).
 */
async function makeTempCwd(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-checkpoint-'))
  await writeFile(path.join(dir, '.gitignore'), '.myagent/\n', 'utf8')
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

const SESSION_ID = '00000000-0000-4000-8000-000000000000'

describe('CheckpointService', () => {
  let gitAvailable = false

  before(async () => {
    gitAvailable = await isGitAvailable()
  })

  it('init creates shadow git directory structure', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()

      const shadowGitDir = path.join(cwd, '.myagent', 'shadow-git', SESSION_ID)
      // Verify the directory and key git files exist.
      await access(shadowGitDir)
      await access(path.join(shadowGitDir, 'HEAD'))
      await access(path.join(shadowGitDir, 'config'))

      // Verify the worktree was configured to point at the project root.
      const config = await readFile(path.join(shadowGitDir, 'config'), 'utf8')
      assert.ok(
        config.includes('worktree'),
        'config file should contain core.worktree setting'
      )

      // isInitialized should now report true.
      assert.equal(await service.isInitialized(), true)
    } finally {
      await cleanup(cwd)
    }
  })

  it('createCheckpoint returns a valid commit hash', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      // Create a file in the worktree so the first commit has real changes.
      await writeFile(path.join(cwd, 'hello.txt'), 'hello world\n', 'utf8')

      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()

      const result = await service.createCheckpoint('msg-1')

      assert.equal(result.success, true)
      assert.ok(result.commitHash, 'commit hash should be returned')
      // A full git SHA-1 hash is 40 hex chars (SHA-256 is 64). Either is acceptable.
      assert.match(
        result.commitHash!,
        /^[0-9a-f]{40}([0-9a-f]{24})?$/,
        'commit hash should be a valid hex SHA'
      )
      assert.notEqual(result.reusedPrevious, true)
    } finally {
      await cleanup(cwd)
    }
  })

  it('createCheckpoint with no changes reuses the previous commit hash', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      // Add a file and create the first checkpoint.
      await writeFile(path.join(cwd, 'a.txt'), 'first\n', 'utf8')

      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()

      const first = await service.createCheckpoint('msg-1')
      assert.equal(first.success, true)
      assert.ok(first.commitHash)

      // Without modifying any files, create a second checkpoint.
      const second = await service.createCheckpoint('msg-2')
      assert.equal(second.success, true)
      assert.equal(
        second.commitHash,
        first.commitHash,
        'second checkpoint should reuse the first commit hash'
      )
      assert.equal(second.reusedPrevious, true)
    } finally {
      await cleanup(cwd)
    }
  })

  it('restoreToCommit succeeds with a valid commit hash', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const filePath = path.join(cwd, 'note.txt')

      // Initial state: "version 1"
      await writeFile(filePath, 'version 1\n', 'utf8')

      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()

      const first = await service.createCheckpoint('msg-1')
      assert.equal(first.success, true)
      assert.ok(first.commitHash)

      // Modify the file and create a second checkpoint.
      await writeFile(filePath, 'version 2\n', 'utf8')
      const second = await service.createCheckpoint('msg-2')
      assert.equal(second.success, true)
      assert.notEqual(second.commitHash, first.commitHash)

      // Restore to the first commit and verify the file content reverted.
      const restoreResult = await service.restoreToCommit(first.commitHash!)
      assert.equal(restoreResult.success, true)

      const restored = await readFile(filePath, 'utf8')
      assert.equal(restored, 'version 1\n')
    } finally {
      await cleanup(cwd)
    }
  })

  it('restoreToCommit fails gracefully with an invalid commit hash', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      await writeFile(path.join(cwd, 'a.txt'), 'content\n', 'utf8')

      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()
      await service.createCheckpoint('msg-1')

      // A clearly invalid hash that does not exist in the repo.
      const result = await service.restoreToCommit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')

      assert.equal(result.success, false)
      assert.ok(result.error, 'an error message should be returned')
      assert.match(result.error!, /deadbeef|Failed to restore/i)
    } finally {
      await cleanup(cwd)
    }
  })

  it('isInitialized returns false before init() is called', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const service = new CheckpointService(cwd, SESSION_ID)
      assert.equal(await service.isInitialized(), false)
    } finally {
      await cleanup(cwd)
    }
  })

  it('init throws a wrapped error when the cwd is not writable (graceful degradation)', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    // Point at a path that cannot be created on any platform: a path under a
    // file (not a directory). On all OSes, mkdir under a regular file fails.
    const cwd = await makeTempCwd()
    try {
      const blockerFile = path.join(cwd, 'blocker')
      await writeFile(blockerFile, 'not a directory', 'utf8')

      // The shadow git dir would be `<blocker>/.myagent/shadow-git/<session>`,
      // which cannot be created because `blocker` is a regular file.
      const service = new CheckpointService(blockerFile, SESSION_ID)

      await assert.rejects(
        () => service.init(),
        (err: Error) => {
          assert.match(err.message, /Failed to initialize shadow git repo/)
          return true
        }
      )
    } finally {
      await cleanup(cwd)
    }
  })

  it('createCheckpoint returns a failure result when the repo is not initialized', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      // Note: we deliberately do NOT call init() here.
      const service = new CheckpointService(cwd, SESSION_ID)

      const result = await service.createCheckpoint('msg-1')
      assert.equal(result.success, false)
      assert.ok(result.error, 'error message should describe the failure')
      assert.match(result.error!, /Checkpoint creation failed/)
    } finally {
      await cleanup(cwd)
    }
  })

  it('getCheckpoints returns mappings from session metadata with message content', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      await writeFile(path.join(cwd, 'a.txt'), 'data\n', 'utf8')

      const service = new CheckpointService(cwd, SESSION_ID)
      await service.init()
      const create = await service.createCheckpoint('msg-1')
      assert.ok(create.success && create.commitHash)

      // Manually populate session metadata + JSONL the way SessionStore would.
      const sessionsDir = getSessionsDir(cwd)
      await mkdir(sessionsDir, { recursive: true })

      const sessionJsonPath = path.join(sessionsDir, `${SESSION_ID}.json`)
      await writeJsonFile(sessionJsonPath, {
        meta: {
          id: SESSION_ID,
          shortId: SESSION_ID.slice(0, 12),
          createdAt: '2026-05-19T11:45:39.393Z',
          updatedAt: '2026-05-19T11:46:00.000Z',
          messageCount: 1,
          checkpoints: [
            {
              messageId: 'msg-1',
              commitHash: create.commitHash,
              createdAt: '2026-05-19T11:46:00.000Z',
            },
          ],
        },
      })

      const jsonlPath = path.join(sessionsDir, `${SESSION_ID}.jsonl`)
      const userRecord = {
        type: 'message',
        id: 'msg-1',
        role: 'user',
        content: 'Hello, world!',
        createdAt: '2026-05-19T11:46:00.000Z',
      }
      await writeFile(jsonlPath, JSON.stringify(userRecord) + '\n', 'utf8')

      const checkpoints = await service.getCheckpoints()
      assert.equal(checkpoints.length, 1)
      assert.equal(checkpoints[0]!.messageId, 'msg-1')
      assert.equal(checkpoints[0]!.commitHash, create.commitHash)
      assert.equal(checkpoints[0]!.messageContent, 'Hello, world!')
      assert.equal(checkpoints[0]!.timestamp, '2026-05-19T11:46:00.000Z')
    } finally {
      await cleanup(cwd)
    }
  })

  it('getCheckpoints returns an empty array when session metadata is missing', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available on this system')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const service = new CheckpointService(cwd, SESSION_ID)
      const checkpoints = await service.getCheckpoints()
      assert.deepEqual(checkpoints, [])
    } finally {
      await cleanup(cwd)
    }
  })
})
