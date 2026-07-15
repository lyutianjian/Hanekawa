import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getModelCapability,
  getModelCapabilityOrDefault,
  isSlotCapDisabled,
  CAPPED_DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
} from '../src/prompts/modelCapabilities.js'
import { getMaxOutputTokens } from '../src/config/providers/anthropicPayload.js'

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

test('isSlotCapDisabled returns true when MYAGENT_SLOT_CAP_DISABLED=1', () => {
  const original = process.env.MYAGENT_SLOT_CAP_DISABLED
  try {
    process.env.MYAGENT_SLOT_CAP_DISABLED = '1'
    assert.equal(isSlotCapDisabled(), true)
  } finally {
    if (original === undefined) delete process.env.MYAGENT_SLOT_CAP_DISABLED
    else process.env.MYAGENT_SLOT_CAP_DISABLED = original
  }
})

test('isSlotCapDisabled returns false when MYAGENT_SLOT_CAP_DISABLED is unset', () => {
  const original = process.env.MYAGENT_SLOT_CAP_DISABLED
  try {
    delete process.env.MYAGENT_SLOT_CAP_DISABLED
    assert.equal(isSlotCapDisabled(), false)
  } finally {
    if (original !== undefined) process.env.MYAGENT_SLOT_CAP_DISABLED = original
  }
})

test('isSlotCapDisabled returns false for non-1 values', () => {
  const original = process.env.MYAGENT_SLOT_CAP_DISABLED
  try {
    process.env.MYAGENT_SLOT_CAP_DISABLED = '0'
    assert.equal(isSlotCapDisabled(), false)
  } finally {
    if (original === undefined) delete process.env.MYAGENT_SLOT_CAP_DISABLED
    else process.env.MYAGENT_SLOT_CAP_DISABLED = original
  }
})

test('getMaxOutputTokens with MYAGENT_SLOT_CAP_DISABLED=1 returns model raw default', () => {
  const origCap = process.env.MYAGENT_SLOT_CAP_DISABLED
  const origMax = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  try {
    process.env.MYAGENT_SLOT_CAP_DISABLED = '1'
    delete process.env.MYAGENT_MAX_OUTPUT_TOKENS
    // sonnet-4-6 raw default is 32k; with cap disabled it should be returned as-is
    assert.equal(getMaxOutputTokens(undefined, 'claude-sonnet-4-6'), 32_000)
    // Unknown model falls back to DEFAULT_CAPABILITY default (32k)
    assert.equal(getMaxOutputTokens(undefined, 'some-unknown-model'), 32_000)
  } finally {
    if (origCap === undefined) delete process.env.MYAGENT_SLOT_CAP_DISABLED
    else process.env.MYAGENT_SLOT_CAP_DISABLED = origCap
    if (origMax === undefined) delete process.env.MYAGENT_MAX_OUTPUT_TOKENS
    else process.env.MYAGENT_MAX_OUTPUT_TOKENS = origMax
  }
})

test('getMaxOutputTokens without MYAGENT_SLOT_CAP_DISABLED returns capped value', () => {
  const origCap = process.env.MYAGENT_SLOT_CAP_DISABLED
  const origMax = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  try {
    delete process.env.MYAGENT_SLOT_CAP_DISABLED
    delete process.env.MYAGENT_MAX_OUTPUT_TOKENS
    // sonnet-4-6 raw default is 32k; capped to 8k
    assert.equal(getMaxOutputTokens(undefined, 'claude-sonnet-4-6'), 8_000)
    // Unknown model: 32k capped to 8k
    assert.equal(getMaxOutputTokens(undefined, 'some-unknown-model'), 8_000)
  } finally {
    if (origCap !== undefined) process.env.MYAGENT_SLOT_CAP_DISABLED = origCap
    if (origMax !== undefined) process.env.MYAGENT_MAX_OUTPUT_TOKENS = origMax
  }
})

test('getMaxOutputTokens MYAGENT_MAX_OUTPUT_TOKENS takes priority over slot cap', () => {
  const origCap = process.env.MYAGENT_SLOT_CAP_DISABLED
  const origMax = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  try {
    process.env.MYAGENT_SLOT_CAP_DISABLED = '1'
    process.env.MYAGENT_MAX_OUTPUT_TOKENS = '16000'
    assert.equal(getMaxOutputTokens(undefined, 'claude-sonnet-4-6'), 16_000)
  } finally {
    if (origCap === undefined) delete process.env.MYAGENT_SLOT_CAP_DISABLED
    else process.env.MYAGENT_SLOT_CAP_DISABLED = origCap
    if (origMax === undefined) delete process.env.MYAGENT_MAX_OUTPUT_TOKENS
    else process.env.MYAGENT_MAX_OUTPUT_TOKENS = origMax
  }
})
