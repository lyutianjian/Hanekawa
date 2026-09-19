import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addCacheBreakpoints,
  getCacheControl,
  resetCacheTTLEvaluation,
  should1hCacheTTL,
} from '../src/harness/cacheControl.js'

test('addCacheBreakpoints marks only the final message with cache_control', () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `msg ${i}` }],
  }))

  const result = addCacheBreakpoints(messages, true, { env: {} })

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
  assert.deepEqual(lastContent[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
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

test('cache ttl1h is the default and both opt-outs still work', () => {
  resetCacheTTLEvaluation()
  assert.equal(should1hCacheTTL({ env: {} }), true)

  resetCacheTTLEvaluation()
  assert.equal(should1hCacheTTL({ env: { MYAGENT_PROMPT_CACHE_1H: '0' } }), false)

  resetCacheTTLEvaluation()
  assert.equal(should1hCacheTTL({ settings: { cache: { ttl1h: false } }, env: {} }), false)
})

test('cache ttl1h settings override environment', () => {
  resetCacheTTLEvaluation()

  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: false } },
    env: { MYAGENT_PROMPT_CACHE_1H: '1' },
  }), false)
})

test('cache ttl1h falls back to environment and stays latched until reset', () => {
  resetCacheTTLEvaluation()

  assert.equal(should1hCacheTTL({ env: { MYAGENT_PROMPT_CACHE_1H: '1' } }), true)
  // A settings reload must not flip the marker shape mid-session: that flip is
  // itself a cache break.
  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: false } },
    env: { MYAGENT_PROMPT_CACHE_1H: '0' },
  }), true)

  resetCacheTTLEvaluation()
  assert.equal(should1hCacheTTL({
    settings: { cache: { ttl1h: false } },
    env: { MYAGENT_PROMPT_CACHE_1H: '0' },
  }), false)
})

test('addCacheBreakpoints marks the final tool_result block', () => {
  resetCacheTTLEvaluation()
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'first' },
        { type: 'tool_result', tool_use_id: 'b', content: 'second' },
      ],
    },
  ]

  const result = addCacheBreakpoints(messages, true, { env: {} })
  const content = result[1]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.cache_control, undefined)
  assert.deepEqual(content[1]?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('addCacheBreakpoints marks a trailing tool_use rather than an earlier text block', () => {
  resetCacheTTLEvaluation()
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      ],
    },
  ]

  const result = addCacheBreakpoints(messages, true, { env: {} })
  const content = result[0]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.cache_control, undefined)
  assert.deepEqual(content[1]?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('addCacheBreakpoints walks back past thinking blocks', () => {
  resetCacheTTLEvaluation()
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      ],
    },
  ]

  const result = addCacheBreakpoints(messages, true, { env: {} })
  const content = result[0]?.content as Array<Record<string, unknown>>
  assert.deepEqual(content[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(content[1]?.cache_control, undefined)
})

test('addCacheBreakpoints leaves an all-thinking message unmarked', () => {
  resetCacheTTLEvaluation()
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'redacted_thinking', data: 'xx' },
      ],
    },
  ]

  const result = addCacheBreakpoints(messages, true, { env: {} })
  const content = result[0]?.content as Array<Record<string, unknown>>
  for (const block of content) {
    assert.equal(block?.cache_control, undefined)
  }
})
