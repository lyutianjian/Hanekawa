import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getCacheBreakpointIndexes,
  addCacheBreakpoints,
  getCacheControl,
  resetCacheTTLEvaluation,
  should1hCacheTTL,
} from '../src/harness/cacheControl.js'

test('getCacheBreakpointIndexes returns empty set for 0 messages', () => {
  const indexes = getCacheBreakpointIndexes(0, 4)
  assert.equal(indexes.size, 0)
})

test('getCacheBreakpointIndexes returns only last index for 1 message', () => {
  const indexes = getCacheBreakpointIndexes(1, 4)
  assert.deepEqual([...indexes], [0])
})

test('getCacheBreakpointIndexes returns only the last index for small arrays', () => {
  const indexes = getCacheBreakpointIndexes(3, 4)
  assert.deepEqual([...indexes], [2])
})

test('getCacheBreakpointIndexes returns only the last index for long arrays', () => {
  const indexes = getCacheBreakpointIndexes(12, 4)
  assert.deepEqual([...indexes], [11])
})

test('getCacheBreakpointIndexes always includes last index', () => {
  for (let count = 1; count <= 20; count++) {
    const indexes = getCacheBreakpointIndexes(count, 4)
    assert.ok(indexes.has(count - 1), `should include index ${count - 1} for count=${count}`)
  }
})

test('getCacheBreakpointIndexes deduplicates when last index aligns with step', () => {
  // 5 messages with step 4: positions [0] then add(4) → [0, 4]
  const indexes = getCacheBreakpointIndexes(5, 4)
  assert.deepEqual([...indexes], [4])
})

test('addCacheBreakpoints marks only the final message with cache_control', () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `msg ${i}` }],
  }))

  const result = addCacheBreakpoints(messages, true, { env: {} })

  // Should have breakpoints at indexes 0, 4, 8
  const cachedIndexes: number[] = []
  for (let i = 0; i < result.length; i++) {
    const content = result[i]?.content as Array<Record<string, unknown>>
    if (content?.[0]?.cache_control) cachedIndexes.push(i)
  }
  assert.deepEqual(cachedIndexes, [8])
})

test('addCacheBreakpoints returns messages unchanged when caching disabled', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]

  const result = addCacheBreakpoints(messages, false, { env: {} })
  for (const msg of result) {
    const content = msg.content as Array<Record<string, unknown>>
    assert.equal(content?.[0]?.cache_control, undefined)
  }
})

test('addCacheBreakpoints handles string content', () => {
  resetCacheTTLEvaluation()
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]

  const result = addCacheBreakpoints(messages, true, { env: {} })
  const lastContent = result[1]?.content as Array<Record<string, unknown>>
  assert.deepEqual(lastContent[0]?.cache_control, { type: 'ephemeral' })
})

test('cache ttl1h can be enabled from runtime settings', () => {
  resetCacheTTLEvaluation()

  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: true } },
    env: { MYAGENT_PROMPT_CACHE_1H: '0' },
  }), true)
  // getCacheControl without runtime re-evaluates from env (no permanent caching).
  assert.deepEqual(getCacheControl({
    settings: { cache: { ttl1h: true } },
    env: { MYAGENT_PROMPT_CACHE_1H: '0' },
  }), { type: 'ephemeral', ttl: '1h' })
})

test('cache ttl1h settings override environment', () => {
  resetCacheTTLEvaluation()

  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: false } },
    env: { MYAGENT_PROMPT_CACHE_1H: '1' },
  }), false)
})

test('cache ttl1h falls back to environment and re-evaluates each call', () => {
  resetCacheTTLEvaluation()

  assert.equal(should1hCacheTTL({ env: { MYAGENT_PROMPT_CACHE_1H: '1' } }), true)
  // Subsequent calls re-evaluate with the new runtime (no permanent caching).
  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: false } },
    env: { MYAGENT_PROMPT_CACHE_1H: '0' },
  }), false)
})
