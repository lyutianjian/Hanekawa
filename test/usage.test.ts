import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateTokenCost, formatUsageLine } from '../src/harness/usage.js'

const usage = {
  cacheReadInputTokens: 100_000,
  inputTokens: 200_000,
  outputTokens: 50_000,
}

test('formatUsageLine shows tokens without pricing', () => {
  assert.equal(
    formatUsageLine(usage),
    'Tokens: cache read 100000, input 200000, output 50000',
  )
})

test('formatUsageLine shows cost with complete pricing', () => {
  assert.equal(
    formatUsageLine(usage, {
      cacheReadInputPerMillionTokens: 0.1,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      currency: 'CNY',
    }),
    'Tokens: cache read 100000, input 200000, output 50000 | Cost: CNY 0.31',
  )
})

test('formatUsageLine falls back to input pricing for unspecified cache prices', () => {
  assert.equal(
    formatUsageLine(usage, {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    }),
    'Tokens: cache read 100000, input 200000, output 50000 | Cost: USD 0.4',
  )
})

test('calculateTokenCost uses per-million token prices', () => {
  const cost = calculateTokenCost(usage, {
    cacheReadInputPerMillionTokens: 0.1,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
    currency: 'USD',
  })

  assert.ok(Math.abs(cost - 0.31) < Number.EPSILON)
})
