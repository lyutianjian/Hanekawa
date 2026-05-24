import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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

test('SessionStore appends metrics next to session records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      response_tokens: 12,
      cache_read_tokens: 34,
      cache_hit_rate: 0.85,
      tool_calls: 2,
      duration_ms: 123,
    })
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: 'filesystem',
      error: 'connection timed out',
    })

    const metricsPath = path.join(dir, '.myagent', 'sessions', `${session.id}.metrics.jsonl`)
    const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2)
    const metric = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    assert.equal(metric.event, 'turn')
    assert.equal(metric.session_id, session.id)
    assert.equal(metric.response_tokens, 12)
    assert.equal(metric.cache_hit_rate, 0.85)
    const mcpMetric = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    assert.equal(mcpMetric.event, 'mcp_connect_failed')
    assert.equal(mcpMetric.session_id, session.id)
    assert.equal(mcpMetric.server, 'filesystem')
    assert.equal(mcpMetric.error, 'connection timed out')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore persists and clears compact failure count in metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.setCompactFailureCount(session.id, 3)
    assert.equal((await store.load(session.id))?.compactFailureCount, 3)

    await store.setCompactFailureCount(session.id, 0)
    assert.equal((await store.load(session.id))?.compactFailureCount, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
