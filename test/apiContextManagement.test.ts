import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getAPIContextManagement,
  DEFAULT_API_CONTEXT_MANAGEMENT_CONFIG,
  type APISideContextManagementConfig,
} from '../src/config/providers/apiContextManagement.js'

test('getAPIContextManagement returns undefined when disabled', () => {
  const result = getAPIContextManagement({
    hasThinking: true,
    config: { enabled: false },
  })
  assert.equal(result, undefined)
})

test('getAPIContextManagement returns strategies when enabled with clearToolResults', () => {
  const result = getAPIContextManagement({
    hasThinking: false,
    config: { enabled: true, clearToolResults: true },
  })
  assert.notEqual(result, undefined)
  assert.ok(result!.edits.length > 0)
})

test('getAPIContextManagement returns undefined when enabled but no strategies applicable', () => {
  // enabled=true but clearToolResults=false and hasThinking=false → no strategies
  const result = getAPIContextManagement({
    hasThinking: false,
    config: { enabled: true, clearToolResults: false, clearThinking: false },
  })
  assert.equal(result, undefined)
})

test('getAPIContextManagement includes tool clearing strategy when clearToolResults is true', () => {
  const result = getAPIContextManagement({
    hasThinking: false,
    config: { enabled: true, clearToolResults: true, triggerTokens: 180_000, targetTokens: 40_000 },
  })
  assert.ok(result)
  const toolStrategy = result.edits.find((s) => s.type === 'clear_tool_uses_20250919')
  assert.ok(toolStrategy)
  if (toolStrategy && 'trigger' in toolStrategy) {
    assert.equal(toolStrategy.trigger?.type, 'input_tokens')
    assert.equal(toolStrategy.trigger?.value, 180_000)
    assert.equal(toolStrategy.clear_at_least?.type, 'input_tokens')
    assert.equal(toolStrategy.clear_at_least?.value, 140_000)
  }
})

test('getAPIContextManagement omits tool clearing when clearToolResults is false', () => {
  const result = getAPIContextManagement({
    hasThinking: true,
    config: { enabled: true, clearToolResults: false, clearThinking: true },
  })
  assert.ok(result)
  const toolStrategy = result.edits.find((s) => s.type === 'clear_tool_uses_20250919')
  assert.equal(toolStrategy, undefined)
  // Should still have thinking strategy
  const thinkingStrategy = result.edits.find((s) => s.type === 'clear_thinking_20251015')
  assert.ok(thinkingStrategy)
})

test('getAPIContextManagement includes thinking clearing when hasThinking is true', () => {
  const result = getAPIContextManagement({
    hasThinking: true,
    config: { enabled: true, clearThinking: true },
  })
  assert.ok(result)
  const thinkingStrategy = result.edits.find((s) => s.type === 'clear_thinking_20251015')
  assert.ok(thinkingStrategy)
  if (thinkingStrategy && 'keep' in thinkingStrategy) {
    assert.equal(thinkingStrategy.keep, 'all')
  }
})

test('getAPIContextManagement keeps only 1 thinking turn when clearAllThinking is true', () => {
  const result = getAPIContextManagement({
    hasThinking: true,
    clearAllThinking: true,
    config: { enabled: true, clearThinking: true },
  })
  assert.ok(result)
  const thinkingStrategy = result.edits.find((s) => s.type === 'clear_thinking_20251015')
  assert.ok(thinkingStrategy)
  if (thinkingStrategy && 'keep' in thinkingStrategy) {
    assert.deepEqual(thinkingStrategy.keep, { type: 'thinking_turns', value: 1 })
  }
})

test('getAPIContextManagement skips thinking clearing when hasThinking is false', () => {
  // With no thinking and no tool clearing, only tool clearing (if enabled) would be present.
  // Here clearToolResults is false, so with hasThinking=false the result is undefined.
  const result = getAPIContextManagement({
    hasThinking: false,
    config: { enabled: true, clearThinking: true, clearToolResults: true },
  })
  assert.ok(result)
  const thinkingStrategy = result.edits.find((s) => s.type === 'clear_thinking_20251015')
  assert.equal(thinkingStrategy, undefined)
  // Tool clearing should still be present
  const toolStrategy = result.edits.find((s) => s.type === 'clear_tool_uses_20250919')
  assert.ok(toolStrategy)
})

test('getAPIContextManagement skips thinking clearing when clearThinking is false', () => {
  const result = getAPIContextManagement({
    hasThinking: true,
    config: { enabled: true, clearThinking: false, clearToolResults: true },
  })
  assert.ok(result)
  const thinkingStrategy = result.edits.find((s) => s.type === 'clear_thinking_20251015')
  assert.equal(thinkingStrategy, undefined)
  // Tool clearing should still be present
  const toolStrategy = result.edits.find((s) => s.type === 'clear_tool_uses_20250919')
  assert.ok(toolStrategy)
})

test('getAPIContextManagement uses custom trigger/target tokens', () => {
  const result = getAPIContextManagement({
    hasThinking: false,
    config: { enabled: true, clearToolResults: true, triggerTokens: 150_000, targetTokens: 30_000 },
  })
  assert.ok(result)
  const toolStrategy = result.edits.find((s) => s.type === 'clear_tool_uses_20250919')
  assert.ok(toolStrategy)
  if (toolStrategy && 'trigger' in toolStrategy) {
    assert.equal(toolStrategy.trigger?.value, 150_000)
    assert.equal(toolStrategy.clear_at_least?.value, 120_000)
  }
})

test('getAPIContextManagement returns undefined when no options provided and default is disabled', () => {
  const result = getAPIContextManagement()
  // Default is disabled (env var not set in test environment)
  assert.equal(result, undefined)
})
