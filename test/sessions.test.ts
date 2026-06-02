import { mkdtemp, rm } from 'node:fs/promises'
import fs, { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/sessions/service.js'
import { rollbackInterruptedPromptIfSynthetic } from '../src/tui/interruptRollback.js'
import type { SessionRecord } from '../src/harness/types.js'
import { getSessionsDir } from '../src/utils/paths.js'

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

test('SessionStore truncateBeforeMessage removes the target message and later records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const records: SessionRecord[] = [
      {
        type: 'message',
        id: 'msg-1',
        role: 'user',
        content: 'first',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        type: 'message',
        id: 'msg-2',
        role: 'assistant',
        content: 'second',
        createdAt: '2026-06-01T00:00:01.000Z',
      },
      {
        type: 'message',
        id: 'msg-3',
        role: 'user',
        content: 'third',
        createdAt: '2026-06-01T00:00:02.000Z',
      },
      {
        type: 'message',
        id: 'msg-4',
        role: 'assistant',
        content: 'fourth',
        createdAt: '2026-06-01T00:00:03.000Z',
      },
    ]
    for (const record of records) {
      await store.appendRecord(session.id, record)
    }
    await store.addCheckpointMapping(session.id, 'msg-1', 'commit-1')
    await store.addCheckpointMapping(session.id, 'msg-3', 'commit-3')

    const result = await store.truncateBeforeMessage(session.id, 'msg-3')
    assert.equal(result.success, true)

    const after = await store.loadRecords(session.id)
    assert.deepEqual(after.map((record) => 'id' in record ? record.id : null), ['msg-1', 'msg-2'])

    const meta = await store.load(session.id)
    assert.equal(meta?.messageCount, 2)
    assert.deepEqual(meta?.checkpoints?.map((mapping) => mapping.messageId), ['msg-1'])

    const jsonlPath = path.join(getSessionsDir(dir), `${session.id}.jsonl`)
    const onDisk = readFileSync(jsonlPath, 'utf-8').trim().split('\n')
    assert.equal(onDisk.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollbackInterruptedPromptIfSynthetic removes interrupted prompt bookkeeping only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'do work',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    await store.appendRecord(session.id, {
      id: 'at-1',
      type: 'at_mention_context',
      userMessageId: 'user-1',
      files: [],
      content: '',
      createdAt: '2026-06-01T00:00:01.000Z',
    })
    await store.appendRecord(session.id, {
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-1',
      prompt: 'do work',
      remainingTasks: [],
      recoverable: true,
      createdAt: '2026-06-01T00:00:02.000Z',
    })

    const restored = await rollbackInterruptedPromptIfSynthetic({
      store,
      sessionId: session.id,
      userMessageId: 'user-1',
    })

    assert.deepEqual(restored, [])
    assert.deepEqual(await store.loadRecords(session.id), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollbackInterruptedPromptIfSynthetic preserves meaningful assistant output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'do work',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'assistant-1',
      role: 'assistant',
      content: 'partial answer',
      createdAt: '2026-06-01T00:00:01.000Z',
    })

    const restored = await rollbackInterruptedPromptIfSynthetic({
      store,
      sessionId: session.id,
      userMessageId: 'user-1',
    })

    assert.equal(restored, null)
    assert.deepEqual((await store.loadRecords(session.id)).map((record) => 'id' in record ? record.id : null), ['user-1', 'assistant-1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore appendRecord updates metadata without rereading JSONL history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  const originalReadFileSync = fs.readFileSync
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const firstMessage: SessionRecord = {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'Initial title',
      createdAt: new Date().toISOString(),
    }
    await store.appendRecord(session.id, firstMessage)

    const jsonlPath = path.join(getSessionsDir(dir), `${session.id}.jsonl`)
    fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(filePath) === jsonlPath) {
        throw new Error('appendRecord should not reread JSONL history')
      }
      return originalReadFileSync(filePath, ...(args as [BufferEncoding | undefined]))
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'msg-2',
      role: 'assistant',
      content: 'Second message',
      createdAt: new Date().toISOString(),
    })
    await store.appendRecord(session.id, {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Read',
      input: { file_path: 'README.md' },
      riskLevel: 'safe',
      createdAt: new Date().toISOString(),
    })

    const loaded = await store.load(session.id)
    assert.equal(loaded?.messageCount, 2)
    assert.equal(loaded?.title, 'Initial title')
  } finally {
    fs.readFileSync = originalReadFileSync
    syncBuiltinESMExports()
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
      input_tokens: 6,
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
    assert.equal(lines.length, 3)
    const metric = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    assert.equal(metric.event, 'turn')
    assert.equal(metric.session_id, session.id)
    assert.equal(metric.input_tokens, 6)
    assert.equal(metric.response_tokens, 12)
    assert.equal(metric.cache_hit_rate, 0.85)
    const summary = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    assert.equal(summary.event, 'session_cache_summary')
    assert.equal(summary.total_turns, 1)
    assert.equal(summary.total_cache_hit_rate, 34 / 40)
    const mcpMetric = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>
    assert.equal(mcpMetric.event, 'mcp_connect_failed')
    assert.equal(mcpMetric.session_id, session.id)
    assert.equal(mcpMetric.server, 'filesystem')
    assert.equal(mcpMetric.error, 'connection timed out')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore summarizes cache break causes in metrics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 100,
      response_tokens: 5,
      cache_read_tokens: 300,
      cache_hit_rate: 0.75,
      tool_calls: 0,
      duration_ms: 10,
    })
    await store.appendMetric(session.id, {
      event: 'cache_break',
      source: `agent:${session.id}`,
      reasons: ['system_prompt_changed(+10 chars)', 'beta_headers_changed'],
      drop_tokens: 2500,
    })

    const metricsPath = path.join(dir, '.myagent', 'sessions', `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const summary = [...metrics].reverse().find((metric) => metric.event === 'session_cache_summary')
    assert.equal(summary?.total_cache_hit_rate, 0.75)
    assert.equal(summary?.first_break_turn_count, 1)
    assert.equal(summary?.cache_break_count, 1)
    assert.deepEqual(summary?.cause_distribution, {
      system_prompt_changed: 1,
      beta_headers_changed: 1,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore restores cache summary before first metric append', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 100,
      response_tokens: 5,
      cache_read_tokens: 300,
      cache_hit_rate: 0.75,
      tool_calls: 0,
      duration_ms: 10,
    })
    await store.appendMetric(session.id, {
      event: 'cache_break',
      source: `agent:${session.id}`,
      reasons: ['tool_schemas_changed'],
      drop_tokens: 2500,
    })

    const restartedStore = new SessionStore(dir)
    await restartedStore.init()
    await restartedStore.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 200,
      response_tokens: 8,
      cache_read_tokens: 200,
      cache_hit_rate: 0.5,
      tool_calls: 1,
      duration_ms: 20,
    })

    const metricsPath = path.join(dir, '.myagent', 'sessions', `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const summary = [...metrics].reverse().find((metric) => metric.event === 'session_cache_summary')
    assert.equal(summary?.total_turns, 2)
    assert.equal(summary?.total_cache_hit_rate, 500 / 800)
    assert.equal(summary?.first_break_turn_count, 1)
    assert.equal(summary?.cache_break_count, 1)
    assert.deepEqual(summary?.cause_distribution, {
      tool_schemas_changed: 1,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore loads cache and compact metrics summary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    for (let i = 0; i < 6; i += 1) {
      await store.appendMetric(session.id, {
        event: 'turn',
        model: 'fake-model',
        input_tokens: 100,
        response_tokens: 5,
        cache_read_tokens: 100,
        cache_hit_rate: 0.5,
        tool_calls: 0,
        duration_ms: 10,
      })
      if (i === 1 || i === 5) {
        await store.appendMetric(session.id, {
          event: 'compact',
          model: 'fake-model',
          pre_tokens: 10_000,
          post_tokens: 4_000,
          compact_duration_ms: 25,
        })
      }
    }

    const summary = await store.loadMetricsSummary(session.id)
    assert.equal(summary?.totalTurns, 6)
    assert.equal(summary?.totalCacheHitRate, 0.5)
    assert.equal(summary?.averageCompactIntervalTurns, 4)

    const restartedStore = new SessionStore(dir)
    await restartedStore.init()
    const restoredSummary = await restartedStore.loadMetricsSummary(session.id)
    assert.equal(restoredSummary?.totalTurns, 6)
    assert.equal(restoredSummary?.totalCacheHitRate, 0.5)
    assert.equal(restoredSummary?.averageCompactIntervalTurns, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore returns null metrics summary when no metrics exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    assert.equal(await store.loadMetricsSummary(session.id), null)
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

test('SessionStore persists denial state metadata and emits metrics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.setDenialState(session.id, { streaks: { Bash: 2 }, total: 5 })

    assert.deepEqual((await store.load(session.id))?.denialState, {
      streaks: { Bash: 2 },
      total: 5,
    })
    assert.deepEqual(await store.getDenialState(session.id), {
      streaks: { Bash: 2 },
      total: 5,
    })

    const metricsPath = path.join(dir, '.myagent', 'sessions', `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(metrics.length, 1)
    assert.equal(metrics[0]?.event, 'permission_denial_state')
    assert.equal(metrics[0]?.total_auto_denials, 5)
    assert.equal(metrics[0]?.active_streaks, 1)
    assert.equal(metrics[0]?.max_streak, 2)
    assert.deepEqual(metrics[0]?.streaks, { Bash: 2 })

    await store.setDenialState(session.id, { streaks: {}, total: 0 })
    assert.equal((await store.load(session.id))?.denialState, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore repairs orphan tool protocol records in JSONL sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Grep',
      input: { pattern: 'x' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:00.000Z',
      turnId: 'turn-1',
    })
    await store.appendRecord(session.id, {
      type: 'tool_result',
      id: 'result-2',
      toolUseId: 'missing-call',
      tool: 'Read',
      ok: true,
      content: 'orphan result',
      createdAt: '2026-05-24T00:00:01.000Z',
      turnId: 'turn-1',
    })

    const result = await store.repairRecords(session.id)
    assert.equal(result.repairedCount, 2)

    const records = await store.loadRecords(session.id)
    assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
    assert.ok(records.some((record) => record.type === 'tool_use' && record.id === 'missing-call'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
