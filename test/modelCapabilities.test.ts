import test from 'node:test'
import assert from 'node:assert/strict'
import { getModelCapability, getModelCapabilityOrDefault, CAPPED_DEFAULT_MAX_TOKENS, ESCALATED_MAX_TOKENS } from '../src/prompts/modelCapabilities.js'

test('getModelCapability returns undefined for unknown models', () => {
  const cap = getModelCapability('some-unknown-model')
  assert.equal(cap, undefined)
})

test('getModelCapabilityOrDefault returns raw defaults for unknown models', () => {
  const cap = getModelCapabilityOrDefault('some-unknown-model')
  assert.equal(cap.contextWindow, 200_000)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 64_000)
})

test('getModelCapability matches claude-sonnet-4-6', () => {
  const cap = getModelCapability('claude-sonnet-4-6')
  assert.ok(cap)
  assert.equal(cap.contextWindow, 200_000)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 128_000)
})

test('getModelCapability matches claude-opus-4-6', () => {
  const cap = getModelCapability('claude-opus-4-6')
  assert.ok(cap)
  assert.equal(cap.contextWindow, 200_000)
  assert.equal(cap.defaultMaxOutputTokens, 64_000)
  assert.equal(cap.upperMaxOutputTokens, 128_000)
})

test('getModelCapability matches claude-opus-4-5', () => {
  const cap = getModelCapability('claude-opus-4-5-20250615')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 64_000)
})

test('getModelCapability matches claude-haiku-4', () => {
  const cap = getModelCapability('claude-haiku-4-5-20251001')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 64_000)
})

test('getModelCapability matches claude-opus-4-1', () => {
  const cap = getModelCapability('claude-opus-4-1-20250414')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 32_000)
})

test('getModelCapability matches claude-opus-4 (no minor version)', () => {
  const cap = getModelCapability('claude-opus-4')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 32_000)
})

test('getModelCapability matches claude-3-opus', () => {
  const cap = getModelCapability('claude-3-opus-20240229')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 4_096)
  assert.equal(cap.upperMaxOutputTokens, 4_096)
})

test('getModelCapability matches claude-3-5-sonnet', () => {
  const cap = getModelCapability('claude-3-5-sonnet-20241022')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 8_192)
  assert.equal(cap.upperMaxOutputTokens, 8_192)
})

test('getModelCapability matches claude-3-7-sonnet', () => {
  const cap = getModelCapability('claude-3-7-sonnet-20250219')
  assert.ok(cap)
  assert.equal(cap.defaultMaxOutputTokens, 32_000)
  assert.equal(cap.upperMaxOutputTokens, 64_000)
})

test('getModelCapability is case-insensitive', () => {
  const cap = getModelCapability('Claude-Sonnet-4-6')
  assert.ok(cap)
  assert.equal(cap.upperMaxOutputTokens, 128_000)
})

test('getModelCapability prefers more specific patterns', () => {
  // sonnet-4-6 should NOT match sonnet-4 pattern
  const sonnet46 = getModelCapability('claude-sonnet-4-6')
  assert.ok(sonnet46)
  assert.equal(sonnet46.upperMaxOutputTokens, 128_000)

  // sonnet-4 (without -6) should match sonnet-4 pattern
  const sonnet4 = getModelCapability('claude-sonnet-4-20250514')
  assert.ok(sonnet4)
  assert.equal(sonnet4.upperMaxOutputTokens, 64_000)
})

test('slot cap constants are defined', () => {
  assert.equal(CAPPED_DEFAULT_MAX_TOKENS, 8_000)
  assert.equal(ESCALATED_MAX_TOKENS, 64_000)
})

test('getModelCapabilityOrDefault respects MYAGENT_SLOT_CAP_DISABLED', async () => {
  const original = process.env.MYAGENT_SLOT_CAP_DISABLED
  try {
    process.env.MYAGENT_SLOT_CAP_DISABLED = '1'
    // Dynamic import to pick up env change
    const mod = await import('../src/prompts/modelCapabilities.js?t=' + Date.now())
    const cap = mod.getModelCapabilityOrDefault('claude-sonnet-4-6')
    // With cap disabled, default should be the model's native default (32k), not capped to 8k
    assert.equal(cap.defaultMaxOutputTokens, 32_000)
  } finally {
    if (original === undefined) delete process.env.MYAGENT_SLOT_CAP_DISABLED
    else process.env.MYAGENT_SLOT_CAP_DISABLED = original
  }
})
