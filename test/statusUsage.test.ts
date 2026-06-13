import test from 'node:test'
import assert from 'node:assert/strict'
import { formatStatusUsage } from '../src/tui/statusUsage.js'

test('formatStatusUsage shows Ready before any turn completes', () => {
  assert.equal(
    formatStatusUsage({
      lastTurn: null,
      total: { cacheReadInputTokens: 4000, inputTokens: 1000, outputTokens: 500 },
    }),
    'Ready',
  )
})

test('formatStatusUsage shows compact token usage with cache hit rate', () => {
  assert.equal(
    formatStatusUsage({
      lastTurn: { cacheReadInputTokens: 4000, inputTokens: 1000, outputTokens: 500 },
      total: { cacheReadInputTokens: 30_208, inputTokens: 313, outputTokens: 544 },
    }),
    '↑1000 ↓500 ⚡4000 80%',
  )
})

test('formatStatusUsage omits cache info when no cache tokens', () => {
  assert.equal(
    formatStatusUsage({
      lastTurn: { cacheReadInputTokens: 0, inputTokens: 1000, outputTokens: 500 },
      total: { cacheReadInputTokens: 0, inputTokens: 1000, outputTokens: 500 },
    }),
    '↑1000 ↓500',
  )
})
