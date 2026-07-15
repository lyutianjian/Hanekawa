import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatToolGroupResultSummary,
  formatToolGroupSummary,
  groupConsecutiveSameToolCalls,
} from '../src/tui/utils/toolGroupSummary.js'
import type { TUIDisplayItem } from '../src/tui/types.js'

type ToolCallItem = Extract<TUIDisplayItem, { kind: 'tool_call' }>

function toolCall(tool: string, overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: 'tool_call',
    id: `tool-call-${tool}-${Math.random().toString(36).slice(2, 8)}`,
    toolUseId: `tu-${tool}-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    input: {},
    status: 'done',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('formatToolGroupSummary', () => {
  it('shows the first three input prefixes without a count', () => {
    const calls = [
      toolCall('WebSearch', { input: { query: 'one' } }),
      toolCall('WebSearch', { input: { query: 'two' } }),
      toolCall('WebSearch', { input: { query: 'three' } }),
      toolCall('WebSearch', { input: { query: 'four' } }),
    ]
    assert.equal(formatToolGroupSummary(calls), 'Web Search (one, two, three, ...)')
  })

  it('truncates each input at 30 terminal columns including CJK text', () => {
    const calls = [
      toolCall('WebSearch', { input: { query: 'abcdefghijklmnopqrstuvwxyz123456789' } }),
      toolCall('WebSearch', { input: { query: '这是一个非常长的中文搜索关键词用于测试截断' } }),
    ]
    assert.equal(
      formatToolGroupSummary(calls),
      'Web Search (abcdefghijklmnopqrstuvwxyz1..., 这是一个非常长的中文搜索关...)',
    )
  })

  it('omits empty parentheses when no input summary is available', () => {
    assert.equal(formatToolGroupSummary([toolCall('Unknown', { input: undefined })]), 'Unknown')
  })
})

describe('formatToolGroupResultSummary', () => {
  it('shows one copy when every structured result summary matches', () => {
    const calls = [
      toolCall('WebSearch', { resultDisplay: { summary: 'No results found' } }),
      toolCall('WebSearch', { resultDisplay: { summary: 'No results found' } }),
    ]
    assert.equal(formatToolGroupResultSummary(calls), 'No results found')
  })

  it('aggregates distinct results and statuses', () => {
    const calls = [
      toolCall('WebSearch', { resultDisplay: { summary: 'Found 3 results' } }),
      toolCall('WebSearch', { resultDisplay: { summary: 'Found 5 results' } }),
      toolCall('WebSearch', { resultDisplay: { summary: 'No results found' } }),
      toolCall('WebSearch', { status: 'error' }),
      toolCall('WebSearch', { status: 'running' }),
    ]
    assert.equal(formatToolGroupResultSummary(calls), '2 found · 1 no result · 1 failed · 1 running')
  })
})

describe('groupConsecutiveSameToolCalls', () => {
  it('groups consecutive calls with the same raw tool name', () => {
    const items: TUIDisplayItem[] = [
      toolCall('WebFetch'),
      toolCall('WebFetch'),
      toolCall('WebFetch'),
    ]
    const out = groupConsecutiveSameToolCalls(items)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.kind, 'tool_group')
  })

  it('does not group different raw tools with the same display name', () => {
    const out = groupConsecutiveSameToolCalls([toolCall('Grep'), toolCall('Glob')])
    assert.deepEqual(out.map((item) => item.kind), ['tool_call', 'tool_call'])
  })

  it('groups command and editing tools but never Agent', () => {
    for (const tool of ['Bash', 'Edit', 'Write']) {
      assert.equal(groupConsecutiveSameToolCalls([toolCall(tool), toolCall(tool)])[0]?.kind, 'tool_group')
    }
    assert.deepEqual(
      groupConsecutiveSameToolCalls([toolCall('Agent'), toolCall('Agent')]).map((item) => item.kind),
      ['tool_call', 'tool_call'],
    )
  })

  it('breaks groups on thought or other transcript items', () => {
    const thought: TUIDisplayItem = {
      kind: 'assistant',
      id: 'thought',
      content: '',
      thinkingBlocks: [{ type: 'thinking', thinking: 'next round' }],
      createdAt: new Date().toISOString(),
    }
    const out = groupConsecutiveSameToolCalls([
      toolCall('WebSearch'), toolCall('WebSearch'), thought,
      toolCall('WebSearch'), toolCall('WebSearch'),
    ])
    assert.deepEqual(out.map((item) => item.kind), ['tool_group', 'assistant', 'tool_group'])
  })

  it('breaks adjacent calls when their hidden-boundary segment differs', () => {
    const out = groupConsecutiveSameToolCalls([
      toolCall('WebSearch', { groupSegmentId: 1 }),
      toolCall('WebSearch', { groupSegmentId: 2 }),
    ])
    assert.deepEqual(out.map((item) => item.kind), ['tool_call', 'tool_call'])
  })

  it('keeps a single groupable tool as a tool call', () => {
    assert.equal(groupConsecutiveSameToolCalls([toolCall('Read')])[0]?.kind, 'tool_call')
  })
})
