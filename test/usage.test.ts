import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTokenUsage,
  cacheHitRate,
  calculateTokenCost,
  formatUsageLine,
  promptTokens,
  resolveUsageWithCost,
} from '../src/harness/usage.js'

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

/**
 * The three input-side counts are disjoint, and every readout that means "how
 * big was this prompt" has to add all three. `promptTokens` is that sum; these
 * pin it, because the alternative — each caller adding the two fields it
 * happens to know about — is how cache writes vanished from the context gauge.
 */
test('promptTokens counts input, writes and reads, never the output', () => {
  assert.equal(promptTokens({
    inputTokens: 100,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 300,
    outputTokens: 40,
  }), 420)
  // Absent writes are zero writes for arithmetic, which is what an
  // OpenAI-compatible endpoint reports.
  assert.equal(promptTokens({ inputTokens: 100, cacheReadInputTokens: 300, outputTokens: 40 }), 400)
  assert.equal(promptTokens(undefined), 0)
})

test('the hit rate has cache writes in its denominator', () => {
  // A write is a miss that was paid for: a cold request that cached its whole
  // prompt must not read as a perfect hit.
  assert.equal(cacheHitRate({
    inputTokens: 0,
    cacheCreationInputTokens: 1000,
    cacheReadInputTokens: 0,
    outputTokens: 10,
  }), 0)
  assert.equal(cacheHitRate({
    inputTokens: 100,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 800,
    outputTokens: 10,
  }), 0.8)
  // Nothing sent at all is "no rate", not a zero.
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 }), null)
})

test('adding usage keeps "not reported" out of the sum', () => {
  // Absence is an answer: a provider that never reports writes must keep
  // producing three-field usage rather than a zero that claims otherwise.
  assert.deepEqual(
    addTokenUsage(
      { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      { inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 30 },
    ),
    { inputTokens: 11, cacheReadInputTokens: 22, outputTokens: 33 },
  )
  assert.deepEqual(
    addTokenUsage(
      { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      { inputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 20, outputTokens: 30 },
    ),
    { inputTokens: 11, cacheCreationInputTokens: 5, cacheReadInputTokens: 22, outputTokens: 33 },
  )
})

test('calculateTokenCost bills cache writes at their own rate', () => {
  // Anthropic charges a write above the input rate; folded into `inputTokens`
  // they were billed as ordinary input, which under-reports every cold turn.
  const cost = calculateTokenCost(
    {
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
    },
    {
      cacheReadInputPerMillionTokens: 0.1,
      cacheWriteInputPerMillionTokens: 1.25,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    },
  )
  assert.ok(Math.abs(cost - 2.35) < 1e-9)
})

test('calculateTokenCost falls back to the input rate for unpriced writes', () => {
  // "Unknown write rate" must not read as "writes are free".
  const cost = calculateTokenCost(
    { inputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 0, outputTokens: 0 },
    { inputPerMillionTokens: 3, outputPerMillionTokens: 2 },
  )
  assert.ok(Math.abs(cost - 3) < 1e-9)
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
