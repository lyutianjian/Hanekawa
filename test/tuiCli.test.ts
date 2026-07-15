import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTuiStartupCommand, resolveStartupSession } from '../src/tui/entrypoints/cli.js'
import type { SessionMeta } from '../src/sessions/service.js'

function meta(id: string, updatedAt: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 12),
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
  }
}

test('parseTuiStartupCommand supports continue aliases', () => {
  assert.deepEqual(parseTuiStartupCommand(['--continue']), { kind: 'continue' })
  assert.deepEqual(parseTuiStartupCommand(['c']), { kind: 'continue' })
})

test('parseTuiStartupCommand supports OTLP endpoint option', () => {
  assert.deepEqual(parseTuiStartupCommand(['--otlp-endpoint', 'http://127.0.0.1:4318', 'c']), {
    kind: 'continue',
    otlpEndpoint: 'http://127.0.0.1:4318',
  })
  assert.deepEqual(parseTuiStartupCommand(['resume', 'abc123', '--otlp-endpoint=http://collector:4318']), {
    kind: 'resume',
    sessionId: 'abc123',
    otlpEndpoint: 'http://collector:4318',
  })
})

test('resolveStartupSession creates an in-memory draft for a new TUI session', async () => {
  const draft = meta('draft-session', '2026-05-24T00:00:00.000Z')
  let called = false
  const session = await resolveStartupSession({ kind: 'new' }, {
    createDraft() {
      called = true
      return draft
    },
    async list() {
      throw new Error('list should not be called')
    },
    async resolve() {
      throw new Error('resolve should not be called')
    },
  })
  assert.equal(called, true)
  assert.equal(session.id, draft.id)
})

test('resolveStartupSession continues the latest listed session', async () => {
  const older = meta('older-session', '2026-05-23T00:00:00.000Z')
  const newer = meta('newer-session', '2026-05-24T00:00:00.000Z')
  older.messageCount = 1
  newer.messageCount = 1

  const session = await resolveStartupSession({ kind: 'continue' }, {
    createDraft() {
      throw new Error('createDraft should not be called')
    },
    async list() {
      return [newer, older]
    },
    async resolve() {
      throw new Error('resolve should not be called')
    },
  })

  assert.equal(session.id, newer.id)
})

test('resolveStartupSession reports when there is no session to continue', async () => {
  await assert.rejects(
    () => resolveStartupSession({ kind: 'continue' }, {
      createDraft() {
        throw new Error('createDraft should not be called')
      },
      async list() {
        return []
      },
      async resolve() {
        throw new Error('resolve should not be called')
      },
    }),
    /No sessions found to continue/,
  )
})
