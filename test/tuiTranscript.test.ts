import test from 'node:test'
import assert from 'node:assert/strict'

import type { SessionRecord, SubagentTaskStatus } from '../src/harness/types.js'
import {
  applyToolProgressToTranscriptState,
  applyTuiRecordToTranscriptState,
  clearToolProgress,
  createTranscriptState,
  recordsToDisplayItems,
} from '../src/tui/transcript.js'

test('transcript reducer keeps running tool calls live and commits results to static transcript', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-1', 'Read', { filePath: 'a.txt' }))

  assert.deepEqual(state.staticItems.map((item) => item.kind), [])
  assert.equal(state.liveItems.length, 1)
  assert.equal(state.liveItems[0]?.kind, 'tool_call')

  state = applyTuiRecordToTranscriptState(state, toolResult('result-1', 'call-1', 'Read', true, 'file contents'))

  assert.equal(state.liveItems.length, 0)
  assert.equal(state.staticItems.length, 1)
  const item = state.staticItems[0]
  assert.equal(item?.kind, 'tool_call')
  assert.equal(item?.status, 'done')
  assert.equal(item?.result, 'file contents')
  assert.equal(state.recentCompletedToolCall?.toolUseId, 'call-1')
})

test('transcript reducer handles multiple parallel tool calls without leaving stale live rows', () => {
  let state = createTranscriptState()
  state = applyTuiRecordToTranscriptState(state, toolUse('call-1', 'Read', { filePath: 'a.txt' }))
  state = applyTuiRecordToTranscriptState(state, toolUse('call-2', 'Glob', { pattern: '*.ts' }))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-2', 'call-2', 'Glob', true, 'b.ts'))
  state = applyTuiRecordToTranscriptState(state, toolResult('result-1', 'call-1', 'Read', true, 'a'))

  assert.equal(state.liveItems.length, 0)
  assert.deepEqual(
    state.staticItems
      .filter((item) => item.kind === 'tool_call')
      .map((item) => item.toolUseId),
    ['call-2', 'call-1'],
  )
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
