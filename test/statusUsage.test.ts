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

test('formatStatusUsage shows the last turn instead of the session total', () => {
  assert.equal(
    formatStatusUsage({
      lastTurn: { cacheReadInputTokens: 4000, inputTokens: 1000, outputTokens: 500 },
      total: { cacheReadInputTokens: 30_208, inputTokens: 313, outputTokens: 544 },
    }),
    'Turn: cache read 4000, input 1000, output 500 | cache: 80% hit',
  )
})

test('formatStatusUsage keeps cost scoped to the last turn', () => {
  assert.equal(
    formatStatusUsage(
      {
        lastTurn: { cacheReadInputTokens: 100_000, inputTokens: 200_000, outputTokens: 50_000 },
        total: { cacheReadInputTokens: 500_000, inputTokens: 800_000, outputTokens: 100_000 },
      },
      {
        cacheReadInputPerMillionTokens: 0.1,
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        currency: 'CNY',
      },
    ),
    'Turn: cache read 100000, input 200000, output 50000 | Cost: CNY 0.31 | cache: 33% hit',
  )
})
