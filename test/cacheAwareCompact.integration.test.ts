import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheEditManager } from '../src/harness/cacheEditManager.js'
import { applyProgressiveCompaction } from '../src/harness/progressiveCompact.js'
import { buildAnthropicMessages, getAnthropicBetaHeaders } from '../src/config/providers/anthropicPayload.js'
import type { ModelRequest } from '../src/harness/types.js'

test('cache-aware microcompact end-to-end: registers, builds payload, includes cache_edits', () => {
  const manager = new CacheEditManager({ keepRecent: 2, triggerAfter: 3 })

  // Build enough records to trigger microcompact (need to exceed threshold)
  const records: Array<{
    type: 'tool_result'
    id: string
    toolUseId: string
    tool: string
    ok: boolean
    content: string
    createdAt: string
  } | {
    type: 'message'
    id: string
    role: 'user'
    content: string
    createdAt: string
  }> = []

  for (let i = 0; i < 20; i++) {
    records.push({
      type: 'tool_result',
      id: `tr-${i}`,
      toolUseId: `tu-${i}`,
      tool: 'Read',
      ok: true,
      content: 'file content '.repeat(2000),
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:00.000Z`,
    })
    records.push({
      type: 'message',
      id: `msg-${i}`,
      role: 'user',
      content: `question ${i}`,
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:30.000Z`,
    })
  }

  // Apply progressive compaction with cache-aware manager
  const result = applyProgressiveCompaction({
    records,
    contextManagement: { contextWindow: 40000, summaryOutputTokens: 2000 },
    cacheEditManager: manager,
  })

  // Cache edits should be pending
  assert.ok(result.cacheEditsPending, 'cacheEditsPending should be true')

  // Consume the pending edits
  const pendingEdits = manager.consumePendingEdits()
  assert.ok(pendingEdits, 'should have pending edits')
  assert.ok(pendingEdits.edits.length > 0, 'should have at least one edit')

  // Build the Anthropic payload using the records as contextItems
  const contextItems = records.map(r => {
    if (r.type === 'tool_result') {
      return { kind: 'tool_result' as const, toolUseId: r.toolUseId, tool: r.tool, content: r.content, ok: r.ok }
    }
    return { kind: 'message' as const, message: r }
  })

  const request: ModelRequest = {
    model: 'claude-sonnet-4-6',
    messages: [],
    contextItems,
    cacheSource: 'repl_main_thread',
    pendingCacheEdits: pendingEdits,
  }

  const messages = buildAnthropicMessages(request)

  // Last user message should contain cache_edits
  const lastMsg = messages[messages.length - 1]
  const lastContent = Array.isArray(lastMsg.content) ? lastMsg.content : []
  const cacheEditsBlock = lastContent.find((b: Record<string, unknown>) => b.type === 'cache_edits')
  assert.ok(cacheEditsBlock, 'cache_edits block should be in last user message')
  assert.ok(
    (cacheEditsBlock as { edits: Array<{ cache_reference: string }> }).edits.length > 0,
    'cache_edits should have at least one edit'
  )

  // Earlier tool_result blocks should have cache_reference
  const toolResultsWithRef = messages
    .slice(0, -1)
    .flatMap((m: Record<string, unknown>) => Array.isArray(m.content) ? m.content : [])
    .filter((b: Record<string, unknown>) => b.type === 'tool_result' && b.cache_reference)
  assert.ok(toolResultsWithRef.length > 0, 'some tool_results should have cache_reference')

  // Beta header should include cache-editing
  const betas = getAnthropicBetaHeaders(request, true)
  assert.ok(betas.some(b => b.includes('cache-editing')), 'beta header should include cache-editing')
})

test('no cache_edits when cacheEditManager not provided', () => {
  const records = [{
    type: 'message' as const,
    id: 'msg-1',
    role: 'user' as const,
    content: 'hello',
    createdAt: '2026-06-16T00:00:00.000Z',
  }]

  const result = applyProgressiveCompaction({
    records,
    contextManagement: { contextWindow: 40000, summaryOutputTokens: 2000 },
  })

  assert.equal(result.cacheEditsPending, undefined)

  const request: ModelRequest = {
    model: 'claude-sonnet-4-6',
    messages: [],
    contextItems: [{ kind: 'message', message: records[0] }],
    cacheSource: 'repl_main_thread',
  }

  const messages = buildAnthropicMessages(request)
  const hasCacheEdits = messages.some((m: Record<string, unknown>) =>
    (Array.isArray(m.content) ? m.content : []).some((b: Record<string, unknown>) => b.type === 'cache_edits')
  )
  assert.equal(hasCacheEdits, false, 'should not have cache_edits without manager')
})
