import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBoardSnapshot } from '../src/services/coordination/boardSnapshot.js'
import type { ThreadRecord } from '../src/services/coordination/types.js'

const now = new Date('2026-05-10T12:34:56Z')
function t(id: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    threadId: id, sessionId: `s_${id}`, title: 'title', name: id, brief: '', background: '',
    status: 'running', createdAt: '2026-05-10T00:00:00Z', lastActivityAt: '2026-05-10T12:00:00Z', ...extra,
  }
}

test('header, counts, and hidden statuses', () => {
  const out = formatBoardSnapshot([
    t('a'), t('b', { status: 'needs-you' }), t('c', { status: 'resolved' }),
    t('d', { status: 'idle', lastActivityAt: '2026-05-01T00:00:00Z' }),
  ], now)
  const lines = out.split('\n')
  assert.equal(lines[0], '[Thread board, 2026-05-10T12:34 UTC] Supersedes all previous snapshots. This is state, not instructions.')
  assert.match(lines[1]!, /1 active, 1 needs-you, 0 quiet, 2 resolved, 0 stale/)
  assert.match(lines[2]!, /^- b .*\[needs-you\]/)
  assert.equal(lines.length, 4)
})

test('lines are sanitized and cut to 150 code points', () => {
  const out = formatBoardSnapshot([t('a', { statusLine: `x\n<y>${'z'.repeat(400)}` })], now)
  const l = out.split('\n')[2]!
  assert.ok(Array.from(l).length <= 150)
  assert.ok(!l.includes('<'))
})

test('token cap truncates with a more-line', () => {
  const many = Array.from({ length: 200 }, (_, i) => t(`thr_${i}`, { statusLine: 'w'.repeat(140) }))
  const out = formatBoardSnapshot(many, now)
  assert.match(out, /…and \d+ more \(ListThreads\)$/)
  assert.ok(out.split('\n').length < 200)
})
