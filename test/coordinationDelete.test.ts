import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deleteSessionArtifacts } from '../src/runtime/deleteSession.js'
import { CoordinationStore } from '../src/services/coordination/threadStore.js'
import type { ThreadRecord } from '../src/services/coordination/types.js'
import { SessionStore } from '../src/sessions/service.js'
import { getProjectDataDir } from '../src/utils/paths.js'

const COORD = '00000000-0000-4000-8000-000000000001'
const T1 = '00000000-0000-4000-8000-000000000002'
const T2 = '00000000-0000-4000-8000-000000000003'

function thread(threadId: string, sessionId: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    threadId, sessionId, title: threadId, name: threadId, brief: '', background: '',
    status: 'idle', createdAt: 'now', lastActivityAt: 'now', ...extra,
  }
}

const noopStore = { delete: async () => {} }

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-coord-delete-'))
  try {
    await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('deleting a thread session marks it stale and keeps the others', async () => {
  await withCwd(async (cwd) => {
    const coord = new CoordinationStore(cwd)
    await coord.setCoordinatorSessionId(COORD)
    await coord.upsertThread(thread('thr_a', T1))
    await coord.upsertThread(thread('thr_b', T2))
    await deleteSessionArtifacts(cwd, noopStore, T1)
    const file = await coord.read()
    assert.equal(file.threads.find((t) => t.threadId === 'thr_a')?.status, 'stale')
    assert.equal(file.threads.find((t) => t.threadId === 'thr_b')?.status, 'idle')
    assert.equal(file.coordinator?.sessionId, COORD)
  })
})

test('deleting the coordinator clears the pointer and keeps threads', async () => {
  await withCwd(async (cwd) => {
    const coord = new CoordinationStore(cwd)
    await coord.setCoordinatorSessionId(COORD)
    await coord.upsertThread(thread('thr_a', T1))
    await deleteSessionArtifacts(cwd, noopStore, COORD)
    const file = await coord.read()
    assert.equal(file.coordinator, undefined)
    assert.equal(file.threads.length, 1)
    assert.equal(file.threads[0]!.status, 'idle')
  })
})

test('without a coordination file nothing is created', async () => {
  await withCwd(async (cwd) => {
    await deleteSessionArtifacts(cwd, noopStore, T1)
    assert.equal(existsSync(path.join(getProjectDataDir(cwd), 'coordination')), false)
  })
})

test('deleting a thread session removes its git worktree and branch', async () => {
  await withCwd(async (cwd) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git('init', '-q')
    await writeFile(path.join(cwd, 'a.txt'), 'a')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    const wt = `${cwd}-wt`
    try {
      git('worktree', 'add', '-q', '-b', 'thread/a', wt)
      const coord = new CoordinationStore(cwd)
      await coord.upsertThread(thread('thr_a', T1, { worktree: { path: wt, branch: 'thread/a', baseRef: 'HEAD', cwd: wt } }))
      await deleteSessionArtifacts(cwd, noopStore, T1)
      assert.equal(existsSync(wt), false)
      assert.equal(git('branch', '--list', 'thread/a').trim(), '')
      assert.equal((await coord.read()).threads[0]!.status, 'stale')
    } finally {
      await rm(wt, { recursive: true, force: true })
    }
  })
})

test('SessionMeta.coordination round-trips through the index', async () => {
  await withCwd(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const meta = await store.create('t')
    await store.setCoordination(meta.id, { role: 'thread', projectKey: 'k', threadId: 'thr_a' })
    await store.setCompactFailureCount(meta.id, 1)
    const again = new SessionStore(cwd)
    await again.init()
    assert.deepEqual((await again.list())[0]!.coordination, { role: 'thread', projectKey: 'k', threadId: 'thr_a' })
    await store.setCoordination(meta.id, undefined)
    assert.equal((await again.list())[0]!.coordination, undefined)
  })
})
