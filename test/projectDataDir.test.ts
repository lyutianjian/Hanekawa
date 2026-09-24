import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/sessions/service.js'
import {
  getProjectDataDir,
  getProjectPlansDir,
  getSessionsDir,
  getToolResultSpillDir,
  projectDataKey,
  resolveToolPath,
} from '../src/utils/paths.js'

/**
 * Runtime data lives under `~/.myagent/projects/<key>/`, never in the project:
 * opening a folder and talking in it must leave the folder as it was.
 */

async function makeProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'myagent-data-dir-'))
}

test('the key is readable and still tells apart paths that flatten alike', () => {
  const key = projectDataKey('/Users/me/code/foo')
  assert.match(key, /Users-me-code-foo-[0-9a-f]{8}$/i)
  assert.notEqual(projectDataKey('/a/b-c'), projectDataKey('/a/b/c'))
  assert.equal(path.dirname(getProjectDataDir('/a/b')), path.join(os.homedir(), '.myagent', 'projects'))
})

test('a session with records leaves no .myagent in the project', async () => {
  const cwd = await makeProject()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create('hello')
    await store.appendRecord(session.id, {
      type: 'user',
      id: 'u1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    } as never)

    assert.equal(existsSync(path.join(cwd, '.myagent')), false)
    assert.equal(existsSync(path.join(getSessionsDir(cwd), `${session.id}.jsonl`)), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a renamed project starts empty and its old history stays under the old key', async () => {
  const parent = await makeProject()
  const before = path.join(parent, 'before')
  const after = path.join(parent, 'after')
  try {
    await mkdir(before)
    const store = new SessionStore(before)
    await store.init()
    const session = await store.create('old')

    await rename(before, after)

    const moved = new SessionStore(after)
    await moved.init()
    assert.deepEqual(await moved.list(), [])
    assert.equal(existsSync(path.join(getSessionsDir(before), `${session.id}.jsonl`)), true)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('file tools reach this session\'s spill dir and the plans dir, nothing else outside the project', async () => {
  const cwd = await makeProject()
  try {
    const context = { cwd, sessionId: 'session-a' }
    const spill = path.join(getToolResultSpillDir(cwd, 'session-a'), 'toolu_1.txt')
    await mkdir(path.dirname(spill), { recursive: true })
    await writeFile(spill, 'x', 'utf8')

    assert.equal(resolveToolPath(context, spill), spill)
    // A plan file that does not exist yet: plan mode Writes it.
    const plan = path.join(getProjectPlansDir(cwd), 'some-slug.md')
    assert.equal(resolveToolPath(context, plan), plan)
    assert.equal(resolveToolPath(context, 'src/a.ts'), path.join(cwd, 'src/a.ts'))

    const otherSpill = path.join(getToolResultSpillDir(cwd, 'session-b'), 'toolu_1.txt')
    assert.throws(() => resolveToolPath(context, otherSpill), /outside the working directory/)
    assert.throws(() => resolveToolPath(context, path.join(getSessionsDir(cwd), 'index.json')), /outside the working directory/)
    assert.throws(() => resolveToolPath(context, path.join(getProjectPlansDir(cwd), '..', 'sessions', 'x.jsonl')), /outside the working directory/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
