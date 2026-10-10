import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IDLE_COMPACT_MIN_OCCUPANCY,
  lastCompactSummary,
  shouldIdleCompact,
} from '../src/runtime/coordination/contextPolicy.js'
import type { SessionRecord } from '../src/harness/types.js'

test('IDLE_COMPACT_MIN_OCCUPANCY is 0.4', () => {
  assert.equal(IDLE_COMPACT_MIN_OCCUPANCY, 0.4)
})

test('shouldIdleCompact requires idle time strictly beyond the cache TTL', () => {
  const base = { cacheTtlMs: 300_000, occupiedTokens: 90_000, usableContextWindow: 100_000 }
  assert.equal(shouldIdleCompact({ ...base, idleMs: 300_001 }), true)
  assert.equal(shouldIdleCompact({ ...base, idleMs: 300_000 }), false)
  assert.equal(shouldIdleCompact({ ...base, idleMs: 1_000 }), false)
})

test('shouldIdleCompact requires known occupancy', () => {
  assert.equal(shouldIdleCompact({
    idleMs: 999_999, cacheTtlMs: 300_000, usableContextWindow: 100_000,
  }), false)
})

test('shouldIdleCompact requires a positive usable window', () => {
  assert.equal(shouldIdleCompact({
    idleMs: 999_999, cacheTtlMs: 300_000, occupiedTokens: 50_000, usableContextWindow: 0,
  }), false)
})

test('shouldIdleCompact requires occupancy strictly above 0.4', () => {
  const base = { idleMs: 999_999, cacheTtlMs: 300_000, usableContextWindow: 100_000 }
  assert.equal(shouldIdleCompact({ ...base, occupiedTokens: 40_000 }), false)
  assert.equal(shouldIdleCompact({ ...base, occupiedTokens: 40_001 }), true)
  assert.equal(shouldIdleCompact({ ...base, occupiedTokens: 10_000 }), false)
})

test('lastCompactSummary returns the summary of the most recent compact_boundary', () => {
  const records = [
    { type: 'compact_boundary', id: '1', summary: 'OLD', preTokens: 1, createdAt: 'x' },
    { type: 'message', id: '2', role: 'user', content: 'hi', createdAt: 'x' },
    { type: 'compact_boundary', id: '3', summary: 'NEW', preTokens: 1, createdAt: 'x' },
  ] as unknown as SessionRecord[]
  assert.equal(lastCompactSummary(records), 'NEW')
})

test('lastCompactSummary is undefined without a compact_boundary', () => {
  assert.equal(lastCompactSummary([]), undefined)
  assert.equal(lastCompactSummary([
    { type: 'message', id: '2', role: 'user', content: 'hi', createdAt: 'x' },
  ] as unknown as SessionRecord[]), undefined)
})
