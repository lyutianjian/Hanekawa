import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionRecord } from '../src/harness/types.js'

test('SessionStore creates, lists, resolves, renames, and deletes sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session1 = await store.create('First session')
    const session2 = await store.create('Second session')

    assert.ok(session1.id)
    assert.ok(session1.shortId)
    assert.ok(session2.id)
    assert.notEqual(session1.id, session2.id)

    const list = await store.list()
    assert.equal(list.length, 2)

    const loaded = await store.load(session1.id)
    assert.ok(loaded)
    assert.equal(loaded?.title, 'First session')

    const resolvedByPrefix = await store.resolve(session1.shortId)
    assert.equal(resolvedByPrefix?.id, session1.id)

    await store.rename(session1.id, 'Renamed session')
    const renamed = await store.load(session1.id)
    assert.equal(renamed?.title, 'Renamed session')

    await store.delete(session1.id)
    const listAfterDelete = await store.list()
    assert.equal(listAfterDelete.length, 1)
    assert.equal(listAfterDelete[0]?.id, session2.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore appends and loads records while updating metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const message: SessionRecord = {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'Hello from session test',
      createdAt: new Date().toISOString(),
    }

    await store.appendRecord(session.id, message)

    const records = await store.loadRecords(session.id)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.type, 'message')

    const loaded = await store.load(session.id)
    assert.equal(loaded?.messageCount, 1)
    assert.equal(loaded?.title, 'Hello from session test')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
