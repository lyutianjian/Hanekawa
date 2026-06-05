import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolGroupSummary, groupConsecutiveSafeToolCalls } from '../src/tui/utils/toolGroupSummary.js'
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
  it('uses past-tense verbs for completed batches', () => {
    const calls = [
      toolCall('Read'), toolCall('Read'), toolCall('Read'),
      toolCall('Grep'), toolCall('Grep'),
    ]
    assert.equal(formatToolGroupSummary(calls), 'Read 3 files, Searched 2 patterns')
  })

  it('uses present-tense when any call is still running', () => {
    const calls = [
      toolCall('Read', { status: 'running' }),
      toolCall('Read'),
      toolCall('Glob'),
    ]
    assert.equal(formatToolGroupSummary(calls), 'Reading 2 files, Searched 1 pattern')
  })

  it('handles singular counts', () => {
    const calls = [toolCall('Read')]
    assert.equal(formatToolGroupSummary(calls), 'Read 1 file')
  })

  it('aggregates tools by userFacingName', () => {
    // Glob and Grep both expose userFacingName="Search" so they merge into
    // one "Searched N patterns" segment.
    const calls = [toolCall('Glob'), toolCall('Read'), toolCall('Grep')]
    assert.equal(formatToolGroupSummary(calls), 'Searched 2 patterns, Read 1 file')
  })
})

describe('groupConsecutiveSafeToolCalls', () => {
  it('merges 2+ consecutive groupable tool_call items into a tool_group', () => {
    const items: TUIDisplayItem[] = [
      toolCall('Read'),
      toolCall('Grep'),
      toolCall('Glob'),
    ]
    const out = groupConsecutiveSafeToolCalls(items)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.kind, 'tool_group')
    if (out[0]!.kind === 'tool_group') {
      assert.equal(out[0]!.toolCalls.length, 3)
    }
  })

  it('keeps a single groupable tool as tool_call (no group)', () => {
    const items: TUIDisplayItem[] = [toolCall('Read')]
    const out = groupConsecutiveSafeToolCalls(items)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.kind, 'tool_call')
  })

  it('does not group Bash, Edit, Write even when consecutive', () => {
    const items: TUIDisplayItem[] = [
      toolCall('Bash'),
      toolCall('Edit'),
      toolCall('Write'),
    ]
    const out = groupConsecutiveSafeToolCalls(items)
    assert.equal(out.length, 3)
    for (const item of out) assert.equal(item.kind, 'tool_call')
  })

  it('breaks runs on non-groupable items', () => {
    const items: TUIDisplayItem[] = [
      toolCall('Read'),
      toolCall('Read'),
      toolCall('Bash'),
      toolCall('Glob'),
      toolCall('Grep'),
    ]
    const out = groupConsecutiveSafeToolCalls(items)
    assert.equal(out.length, 3)
    assert.equal(out[0]!.kind, 'tool_group')
    assert.equal(out[1]!.kind, 'tool_call')
    assert.equal(out[2]!.kind, 'tool_group')
  })

  it('passes through non-tool_call items untouched', () => {
    const assistant: TUIDisplayItem = {
      kind: 'assistant',
      id: 'a1',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }
    const items: TUIDisplayItem[] = [assistant, toolCall('Read'), toolCall('Grep')]
    const out = groupConsecutiveSafeToolCalls(items)
    assert.equal(out.length, 2)
    assert.equal(out[0]!.kind, 'assistant')
    assert.equal(out[1]!.kind, 'tool_group')
  })

  it('returns an empty array for empty input', () => {
    assert.deepEqual(groupConsecutiveSafeToolCalls([]), [])
  })
})
