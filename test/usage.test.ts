import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateTokenCost, formatUsageLine, resolveUsageWithCost } from '../src/harness/usage.js'

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

test('formatUsageLine supports a custom label', () => {
  assert.equal(
    formatUsageLine(usage, undefined, 'Turn'),
    'Turn: cache read 100000, input 200000, output 50000',
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

/**
 * `resolveUsageWithCost` is the single projection behind three readouts: `/cost`
 * in both shells (through `CommandContext.getUsage`) and the desktop status bar
 * (through the `snapshot` event's derived `cost`). It exists because those used to
 * be three copies of the same eight lines.
 */
test('resolveUsageWithCost folds the cost in when pricing is complete', () => {
  const resolved = resolveUsageWithCost(usage, {
    cacheReadInputPerMillionTokens: 0.1,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
    currency: 'CNY',
  })

  assert.equal(resolved.currency, 'CNY')
  assert.ok(resolved.cost !== undefined && Math.abs(resolved.cost - 0.31) < Number.EPSILON)
  // The counts must survive untouched; a status bar reads both halves.
  assert.equal(resolved.inputTokens, usage.inputTokens)
  assert.equal(resolved.cacheReadInputTokens, usage.cacheReadInputTokens)
  assert.equal(resolved.outputTokens, usage.outputTokens)
})

test('resolveUsageWithCost defaults the currency to USD', () => {
  const resolved = resolveUsageWithCost(usage, {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  })

  assert.equal(resolved.currency, 'USD')
})

test('resolveUsageWithCost leaves the cost absent rather than zero without pricing', () => {
  // "Not priced" and "free" are different answers. A zero here would make the
  // status bar claim a session cost nothing and `/cost` stop saying "unavailable".
  assert.equal(resolveUsageWithCost(usage).cost, undefined)
  assert.equal(resolveUsageWithCost(usage, {}).cost, undefined)
  assert.equal(resolveUsageWithCost(usage, { inputPerMillionTokens: 1 }).cost, undefined,
    'half a price list is not a price list')
  assert.equal(resolveUsageWithCost(usage, { outputPerMillionTokens: 2 }).cost, undefined)
})

test('resolveUsageWithCost reports a real zero when nothing has been spent', () => {
  const resolved = resolveUsageWithCost(
    { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
    { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  )

  // Distinct from the case above: priced, but nothing used yet.
  assert.equal(resolved.cost, 0)
  assert.equal(resolved.currency, 'USD')
})
