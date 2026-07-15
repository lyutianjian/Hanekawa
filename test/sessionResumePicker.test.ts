import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionMeta } from '../src/sessions/service.js'
import {
  filterSessionsForResume,
  formatSessionResumeRow,
  sortSessionsForResume,
} from '../src/tui/components/SessionResumePicker.js'

function session(id: string, updatedAt: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 12),
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    ...overrides,
  }
}

test('resume picker sorts sessions newest first', () => {
  const sorted = sortSessionsForResume([
    session('old', '2026-01-01T00:00:00Z'),
    session('new', '2026-01-02T00:00:00Z'),
  ])
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'old'])
})

test('resume picker row shows title, relative time, message count, and current marker', () => {
  const row = formatSessionResumeRow(session('current', '2026-01-02T00:00:00Z', {
    title: 'First user message',
    messageCount: 3,
  }), true, Date.parse('2026-01-02T02:00:00Z'))

  assert.equal(row, 'First user message  2h ago  3 messages  (current)')
})

test('resume picker row falls back to an untitled label', () => {
  assert.match(formatSessionResumeRow(session('empty', '2026-01-02T00:00:00Z'), false), /^\(untitled\)/)
})

test('resume picker hides non-current empty sessions and keeps the current draft', () => {
  const current = session('current', '2026-01-03T00:00:00Z')
  const staleEmpty = session('empty', '2026-01-02T00:00:00Z')
  const resumable = session('resumable', '2026-01-01T00:00:00Z', { messageCount: 2 })
  assert.deepEqual(
    filterSessionsForResume([staleEmpty, resumable, current], current.id).map((item) => item.id),
    [current.id, resumable.id],
  )
})
