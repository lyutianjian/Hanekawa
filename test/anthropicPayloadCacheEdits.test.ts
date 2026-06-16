import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnthropicMessages } from '../src/config/providers/anthropicPayload.js'
import type { ModelRequest } from '../src/harness/types.js'

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-sonnet-4-6',
    messages: [],
    cacheSource: 'repl_main_thread',
    ...overrides,
  }
}

test('buildAnthropicMessages injects cache_edits into last user message', () => {
  const request = makeRequest({
    contextItems: [
      { kind: 'tool_result', toolUseId: 'tu-1', tool: 'Read', content: 'file content', ok: true },
      { kind: 'message', message: { id: 'm1', role: 'user', content: 'question', createdAt: '' } },
    ],
    pendingCacheEdits: {
      type: 'cache_edits',
      edits: [{ type: 'delete', cache_reference: 'tu-1' }],
    },
  })

  const messages = buildAnthropicMessages(request)
  const lastMsg = messages[messages.length - 1]
  const content = lastMsg.content as Array<Record<string, unknown>>
  const cacheEditsBlock = content.find(b => b.type === 'cache_edits')
  assert.ok(cacheEditsBlock, 'should have cache_edits block')
  assert.deepEqual(cacheEditsBlock.edits, [{ type: 'delete', cache_reference: 'tu-1' }])
})

test('buildAnthropicMessages adds cache_reference to tool_result blocks in earlier messages', () => {
  const request = makeRequest({
    contextItems: [
      { kind: 'tool_result', toolUseId: 'tu-1', tool: 'Read', content: 'file content', ok: true },
      { kind: 'message', message: { id: 'm1', role: 'user', content: 'question', createdAt: '' } },
      { kind: 'tool_result', toolUseId: 'tu-2', tool: 'Bash', content: 'output', ok: true },
      { kind: 'message', message: { id: 'm2', role: 'user', content: 'follow up', createdAt: '' } },
    ],
    pendingCacheEdits: {
      type: 'cache_edits',
      edits: [{ type: 'delete', cache_reference: 'tu-1' }],
    },
  })

  const messages = buildAnthropicMessages(request)

  // First message's tool_result should have cache_reference
  const firstMsg = messages[0]
  const firstContent = firstMsg.content as Array<Record<string, unknown>>
  const toolResult = firstContent.find(b => b.type === 'tool_result')
  assert.ok(toolResult)
  assert.equal(toolResult.cache_reference, 'tu-1')

  // All tool_results in non-last messages should have cache_reference
  for (let i = 0; i < messages.length - 1; i++) {
    const content: Array<Record<string, unknown>> = Array.isArray(messages[i].content) ? messages[i].content as Array<Record<string, unknown>> : []
    for (const block of content) {
      if (block.type === 'tool_result') {
        assert.equal(block.cache_reference, block.tool_use_id, `tool_result ${block.tool_use_id} should have cache_reference`)
      }
    }
  }

  // Last message should NOT have cache_reference on tool_results (it's where cache_edits goes)
  const lastMsg = messages[messages.length - 1]
  const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : []
  for (const block of lastContent) {
    if (block.type === 'tool_result') {
      assert.equal(block.cache_reference, undefined, `tool_result ${block.tool_use_id} in last message should not have cache_reference`)
    }
  }
})

test('buildAnthropicMessages re-inserts pinned edits', () => {
  const request = makeRequest({
    contextItems: [
      { kind: 'tool_result', toolUseId: 'tu-1', tool: 'Read', content: 'content', ok: true },
      { kind: 'message', message: { id: 'm1', role: 'user', content: 'q1', createdAt: '' } },
      { kind: 'message', message: { id: 'm2', role: 'user', content: 'q2', createdAt: '' } },
    ],
    pinnedCacheEdits: [
      {
        userMessageIndex: 0,
        block: { type: 'cache_edits', edits: [{ type: 'delete', cache_reference: 'tu-old' }] },
      },
    ],
  })

  const messages = buildAnthropicMessages(request)
  const firstMsg = messages[0]
  const content = firstMsg.content as Array<Record<string, unknown>>
  const cacheEdits = content.find(b => b.type === 'cache_edits')
  assert.ok(cacheEdits, 'should have pinned cache_edits')
  assert.deepEqual(cacheEdits.edits, [{ type: 'delete', cache_reference: 'tu-old' }])
})

test('buildAnthropicMessages deduplicates pinned edits with pending on same message', () => {
  const request = makeRequest({
    contextItems: [
      { kind: 'tool_result', toolUseId: 'tu-1', tool: 'Read', content: 'content', ok: true },
      { kind: 'message', message: { id: 'm1', role: 'user', content: 'q1', createdAt: '' } },
      { kind: 'message', message: { id: 'm2', role: 'user', content: 'q2', createdAt: '' } },
    ],
    pendingCacheEdits: {
      type: 'cache_edits',
      edits: [{ type: 'delete', cache_reference: 'tu-1' }],
    },
    // Pin to message index 1 (the last user message m2), same target as pendingCacheEdits
    pinnedCacheEdits: [
      {
        userMessageIndex: 1,
        block: { type: 'cache_edits', edits: [{ type: 'delete', cache_reference: 'tu-1' }] },
      },
    ],
  })

  const messages = buildAnthropicMessages(request)
  // Should not have duplicate tu-1 deletes on the same message
  const lastMsg = messages[messages.length - 1]
  const content = lastMsg.content as Array<Record<string, unknown>>
  const cacheEditsBlocks = content.filter(b => b.type === 'cache_edits')
  const allRefs = cacheEditsBlocks.flatMap(b => (b.edits as Array<{ cache_reference: string }>).map(e => e.cache_reference))
  assert.equal(allRefs.length, 1, 'should have exactly one tu-1 ref (deduped)')
  assert.deepEqual(allRefs, ['tu-1'])
})

test('buildAnthropicMessages has no cache_edits when pendingCacheEdits is null', () => {
  const request = makeRequest({
    contextItems: [
      { kind: 'message', message: { id: 'm1', role: 'user', content: 'q1', createdAt: '' } },
    ],
    pendingCacheEdits: null,
  })

  const messages = buildAnthropicMessages(request)
  const hasCacheEdits = messages.some(m =>
    (Array.isArray(m.content) ? m.content : []).some(b => b.type === 'cache_edits')
  )
  assert.equal(hasCacheEdits, false)
})
