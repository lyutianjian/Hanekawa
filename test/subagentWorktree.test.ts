import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GitSubagentWorktreeManager } from '../src/services/agents/subagentWorktree.js'

const execFileAsync = promisify(execFile)

test('GitSubagentWorktreeManager creates a detached worktree and summarizes changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-worktree-manager-'))
  const repo = path.join(root, 'repo')
  let worktreePath: string | undefined
  try {
    await git(root, ['init', repo])
    await writeFile(path.join(repo, 'README.md'), 'hello\n', 'utf8')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'])

    const manager = new GitSubagentWorktreeManager()
    const lease = await manager.create({
      cwd: repo,
      parentSessionId: 'parent/session',
      agentId: 'agent-1',
    })
    worktreePath = lease.path
    await writeFile(path.join(lease.path, 'README.md'), 'hello worktree\n', 'utf8')

    const summary = await manager.summarize({ worktreePath: lease.path })

    assert.equal(lease.isolation, 'worktree')
    assert.match(lease.baseRef, /^[0-9a-f]{40}$/)
    assert.match(lease.path, /hanekawa-subagent-worktrees/)
    assert.match(summary, /README\.md/)
  } finally {
    if (worktreePath) {
      await rm(worktreePath, { recursive: true, force: true })
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('GitSubagentWorktreeManager cleanup removes only managed temp worktrees', async () => {
  const manager = new GitSubagentWorktreeManager()
  await mkdir(path.join(tmpdir(), 'hanekawa-subagent-worktrees'), { recursive: true })
  const worktreePath = await mkdtemp(path.join(tmpdir(), 'hanekawa-subagent-worktrees', 'cleanup-test-'))
  const outsidePath = await mkdtemp(path.join(tmpdir(), 'hanekawa-worktree-outside-'))
  try {
    assert.equal(await manager.exists({ worktreePath }), true)

    const result = await manager.cleanup({ cwd: tmpdir(), worktreePath })
    assert.equal(result.removed, true)
    await assert.rejects(access(worktreePath), /ENOENT/)

    await assert.rejects(
      manager.exists({ worktreePath: outsidePath }),
      /outside subagent worktree root/,
    )
  } finally {
    await rm(worktreePath, { recursive: true, force: true })
    await rm(outsidePath, { recursive: true, force: true })
  }
})

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}
