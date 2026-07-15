import test from 'node:test'
import assert from 'node:assert/strict'

import type { SessionRecord, SubagentTaskStatus } from '../src/harness/types.js'
import {
  applyToolProgressToTranscriptState,
  applyTuiRecordToTranscriptState,
  clearToolProgress,
  commitAllLiveItemsToStatic,
  createTranscriptState,
  isHiddenToolCall,
  recordsToDisplayItems,
} from '../src/tui/transcript.js'

test('transcript reducer keeps completed tool calls live until the segment is committed', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-1', 'Read', { filePath: 'a.txt' }))

  assert.deepEqual(state.staticItems.map((item) => item.kind), [])
  assert.equal(state.liveItems.length, 1)
  assert.equal(state.liveItems[0]?.kind, 'tool_call')

  state = applyTuiRecordToTranscriptState(state, toolResult('result-1', 'call-1', 'Read', true, 'file contents'))

  assert.equal(state.liveItems.length, 1)
  assert.equal(state.staticItems.length, 0)
  state = commitAllLiveItemsToStatic(state)
  assert.equal(state.liveItems.length, 0)
  assert.equal(state.staticItems.length, 1)
  const item = state.staticItems[0]
  assert.equal(item?.kind, 'tool_call')
  assert.equal(item?.status, 'done')
  assert.equal(item?.result, 'file contents')
  assert.equal(state.recentCompletedToolCall?.toolUseId, 'call-1')
})

test('transcript reducer ignores at-mention context records', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, {
    type: 'at_mention_context',
    id: 'at1',
    userMessageId: 'u1',
    createdAt: '2026-06-02T00:00:00.000Z',
    files: [],
    content: '<system-reminder>hidden</system-reminder>',
  })

  assert.deepEqual(state.staticItems, [])
  assert.deepEqual(state.liveItems, [])
})

test('transcript reducer preserves original order for parallel results completed out of order', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-1', 'Read', { filePath: 'a.txt' }))
  state = applyTuiRecordToTranscriptState(state, toolUse('call-2', 'Glob', { pattern: '*.ts' }))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-2', 'call-2', 'Glob', true, 'b.ts'))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-1', 'call-1', 'Read', true, 'a'))

  assert.equal(state.liveItems.length, 2)
  state = commitAllLiveItemsToStatic(state)
  assert.equal(state.liveItems.length, 0)
  assert.deepEqual(
    state.staticItems
      .filter((item) => item.kind === 'tool_call')
      .map((item) => item.toolUseId),
    ['call-1', 'call-2'],
  )
})

test('thinking blocks split repeated tools into independent groups', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-1', 'WebSearch', { query: 'one' }))
  state = applyTuiRecordToTranscriptState(state, toolUse('call-2', 'WebSearch', { query: 'two' }))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-1', 'call-1', 'WebSearch', true, 'one'))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-2', 'call-2', 'WebSearch', true, 'two'))
  state = applyTuiRecordToTranscriptState(state, thinkingMessage('thought-1', 'next search round'))
  state = applyTuiRecordToTranscriptState(state, toolUse('call-3', 'WebSearch', { query: 'three' }))
  state = applyTuiRecordToTranscriptState(state, toolUse('call-4', 'WebSearch', { query: 'four' }))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-3', 'call-3', 'WebSearch', true, 'three'))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-4', 'call-4', 'WebSearch', true, 'four'))
  state = commitAllLiveItemsToStatic(state)

  assert.deepEqual(state.staticItems.map((item) => item.kind), ['tool_group', 'assistant', 'tool_group'])
  const groups = state.staticItems.filter((item) => item.kind === 'tool_group')
  assert.deepEqual(groups.map((group) => group.toolCalls.map((call) => call.toolUseId)), [
    ['call-1', 'call-2'],
    ['call-3', 'call-4'],
  ])
})

test('historical hidden tools are hard grouping boundaries', () => {
  const items = recordsToDisplayItems([
    toolUse('call-1', 'WebFetch', { url: 'https://example.com/1' }),
    toolUse('call-2', 'WebFetch', { url: 'https://example.com/2' }),
    toolUse('hidden-1', 'ToolSearch', { query: 'web' }),
    toolUse('call-3', 'WebFetch', { url: 'https://example.com/3' }),
    toolUse('call-4', 'WebFetch', { url: 'https://example.com/4' }),
  ])

  assert.deepEqual(items.map((item) => item.kind), ['tool_group', 'tool_group'])
})

test('transcript reducer keeps running subagents live and commits terminal states', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, subagentTask('subagent-1', 'running'), {
    subagentProgress: 'Reading files',
  })

  assert.equal(state.staticItems.length, 0)
  assert.equal(state.liveItems[0]?.kind, 'subagent_task')
  assert.equal(state.liveItems[0]?.kind === 'subagent_task' ? state.liveItems[0].progress : undefined, 'Reading files')

  state = applyTuiRecordToTranscriptState(state, subagentTask('subagent-2', 'completed'))

  assert.equal(state.liveItems.length, 0)
  assert.equal(state.staticItems[0]?.kind, 'subagent_task')
  assert.equal(state.staticItems[0]?.kind === 'subagent_task' ? state.staticItems[0].record.status : undefined, 'completed')
})

test('tool progress only appears in live items and can be cleared', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, subagentTask('subagent-1', 'running'))
  state = applyToolProgressToTranscriptState(state, {
    listContent: 'Running 2 tools in parallel...',
    subagentProgressByAgentId: new Map([['agent-1', 'Searching']]),
  })

  assert.equal(state.staticItems.length, 0)
  assert.equal(state.liveItems.some((item) => item.kind === 'tool_progress'), true)

  state = clearToolProgress(state)

  assert.equal(state.liveItems.some((item) => item.kind === 'tool_progress'), false)
})

test('recordsToDisplayItems restores historical running subagents as interrupted', () => {
  const items = recordsToDisplayItems([subagentTask('subagent-1', 'running')])
  const item = items[0]

  assert.equal(item?.kind, 'subagent_task')
  assert.equal(item?.kind === 'subagent_task' ? item.record.status : undefined, 'interrupted')
})

// --- isHiddenToolCall tests ---

test('isHiddenToolCall returns true for ToolSearch', () => {
  assert.equal(isHiddenToolCall('ToolSearch'), true)
})

test('isHiddenToolCall returns true for EnterPlanMode and ExitPlanMode', () => {
  assert.equal(isHiddenToolCall('EnterPlanMode'), true)
  assert.equal(isHiddenToolCall('ExitPlanMode'), true)
})

test('isHiddenToolCall returns true for AskUserQuestion', () => {
  assert.equal(isHiddenToolCall('AskUserQuestion'), true)
})

test('isHiddenToolCall returns true for Skill', () => {
  assert.equal(isHiddenToolCall('Skill'), true)
})

test('isHiddenToolCall returns true for task management tools', () => {
  assert.equal(isHiddenToolCall('TaskCreate'), true)
  assert.equal(isHiddenToolCall('TaskList'), true)
  assert.equal(isHiddenToolCall('TaskGet'), true)
  assert.equal(isHiddenToolCall('TaskUpdate'), true)
})

test('isHiddenToolCall returns false for visible tools', () => {
  assert.equal(isHiddenToolCall('Read'), false)
  assert.equal(isHiddenToolCall('Write'), false)
  assert.equal(isHiddenToolCall('Edit'), false)
  assert.equal(isHiddenToolCall('Bash'), false)
  assert.equal(isHiddenToolCall('Grep'), false)
  assert.equal(isHiddenToolCall('Glob'), false)
  assert.equal(isHiddenToolCall('Agent'), false)
  assert.equal(isHiddenToolCall('WebFetch'), false)
  assert.equal(isHiddenToolCall('WebSearch'), false)
  assert.equal(isHiddenToolCall('NotebookEdit'), false)
})

test('ToolSearch tool_use record is completely suppressed from TUI', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-ts-1', 'ToolSearch', { query: 'test', max_results: 5 }))

  assert.deepEqual(state.staticItems, [])
  assert.deepEqual(state.liveItems, [])
})

test('ToolSearch tool_result record is completely suppressed from TUI', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolResult('result-ts-1', 'call-ts-1', 'ToolSearch', true, '{"matches":[],"query":"test","totalDeferredTools":0}'))

  assert.deepEqual(state.staticItems, [])
  assert.deepEqual(state.liveItems, [])
})

test('Task tools are completely suppressed from TUI', () => {
  for (const tool of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    let state = createTranscriptState()
    state = applyTuiRecordToTranscriptState(state, toolUse(`call-${tool}`, tool, {}))
    assert.deepEqual(state.staticItems, [], `${tool} tool_use should be suppressed`)
    assert.deepEqual(state.liveItems, [], `${tool} tool_use should be suppressed`)

    state = applyTuiRecordToTranscriptState(state, toolResult(`result-${tool}`, `call-${tool}`, tool, true, '{}'))
    assert.deepEqual(state.staticItems, [], `${tool} tool_result should be suppressed`)
    assert.deepEqual(state.liveItems, [], `${tool} tool_result should be suppressed`)
  }
})

function toolUse(id: string, tool: string, input: unknown): SessionRecord {
  return {
    id,
    type: 'tool_use',
    tool,
    input,
    riskLevel: 'safe',
    createdAt: '2026-05-24T00:00:00.000Z',
  }
}

function toolResult(id: string, toolUseId: string, tool: string, ok: boolean, content: string): SessionRecord {
  return {
    id,
    type: 'tool_result',
    toolUseId,
    tool,
    ok,
    content,
    createdAt: '2026-05-24T00:00:01.000Z',
  }
}

function subagentTask(id: string, status: SubagentTaskStatus): SessionRecord {
  return {
    id,
    type: 'subagent_task',
    agentId: 'agent-1',
    subagentType: 'explore',
    status,
    description: 'Explore files',
    task: 'Find files',
    createdAt: '2026-05-24T00:00:00.000Z',
  }
}

function thinkingMessage(id: string, thinking: string): SessionRecord {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: '',
    thinkingBlocks: [{ type: 'thinking', thinking }],
    createdAt: '2026-05-24T00:00:02.000Z',
  }
}
