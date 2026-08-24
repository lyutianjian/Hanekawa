import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseGitHead, readGitBranch } from '../src/runtime/gitBranch.js'

/**
 * The branch behind the empty-state screen's third context pill.
 *
 * Every negative case here is a case where the pill must simply not be drawn —
 * `readGitBranch` is on the `hello` path, so a throw would fail a pane attach.
 */

async function scratch(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'hanekawa-git-'))
}

test('parseGitHead reads the branch a symbolic HEAD names', () => {
  assert.equal(parseGitHead('ref: refs/heads/main\n'), 'main')
  assert.equal(parseGitHead('ref: refs/heads/master\r\n'), 'master')
  // Branch names contain slashes; only the prefix is stripped.
  assert.equal(parseGitHead('ref: refs/heads/feature/a-b\n'), 'feature/a-b')
  assert.equal(parseGitHead('   ref: refs/heads/main   '), 'main')
})

test('parseGitHead reports undefined for everything that is not a branch', () => {
  const notBranches = [
    // Detached HEAD, both hash sizes. Hidden rather than shown as a short SHA:
    // the slot means "which branch", and a hash in it reads as a branch name.
    'a'.repeat(40),
    'b'.repeat(64) + '\n',
    'ref: refs/heads/\n',
    'ref: refs/heads/   \n',
    'ref: refs/remotes/origin/main\n',
    'ref: refs/tags/v1\n',
    '',
    '   \n',
    'garbage',
  ]
  for (const contents of notBranches) {
    assert.equal(parseGitHead(contents), undefined, JSON.stringify(contents))
  }
})

test('readGitBranch reads <cwd>/.git/HEAD', async (t) => {
  const cwd = await scratch()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(path.join(cwd, '.git'), { recursive: true })
  await writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/topic\n')

  assert.equal(await readGitBranch(cwd), 'topic')
})

test('readGitBranch is undefined outside a repository', async (t) => {
  const cwd = await scratch()
  t.after(() => rm(cwd, { recursive: true, force: true }))

  assert.equal(await readGitBranch(cwd), undefined)
})

test('readGitBranch is undefined, and does not throw, when .git is a file', async (t) => {
  // A worktree or submodule: `.git` is a `gitdir:` pointer, so the read fails
  // with ENOTDIR rather than ENOENT. The pill is hidden; nothing is followed.
  const cwd = await scratch()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')

  await assert.doesNotReject(() => readGitBranch(cwd))
  assert.equal(await readGitBranch(cwd), undefined)
})

test('readGitBranch is undefined when .git exists without a HEAD', async (t) => {
  const cwd = await scratch()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(path.join(cwd, '.git'), { recursive: true })

  assert.equal(await readGitBranch(cwd), undefined)
})

test('readGitBranch does not walk up to a parent repository', async (t) => {
  // The pill describes the project root. A parent's branch would be a lie.
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.git'), { recursive: true })
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/outer\n')
  const child = path.join(root, 'nested')
  await mkdir(child, { recursive: true })

  assert.equal(await readGitBranch(child), undefined)
})
