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

test('resolveStartupSession continues the latest listed session', async () => {
  const older = meta('older-session', '2026-05-23T00:00:00.000Z')
  const newer = meta('newer-session', '2026-05-24T00:00:00.000Z')

  const session = await resolveStartupSession({ kind: 'continue' }, {
    async create() {
      throw new Error('create should not be called')
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
      async create() {
        throw new Error('create should not be called')
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
