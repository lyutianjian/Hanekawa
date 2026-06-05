import test from 'node:test'
import assert from 'node:assert/strict'
import { recordsToDisplayItems } from '../src/tui/hooks/useAgentLoop.js'
import { formatToolCallRunningDescription, getStatusDot } from '../src/tui/components/ToolCallBlock.js'
import { formatSubagentTaskLine } from '../src/tui/components/SubagentTaskBlock.js'
import { getTaskVisual } from '../src/tui/components/TaskListBlock.js'
import { getToolActivityDescription, getToolDisplay, shouldDisplayToolResult } from '../src/tools/display.js'
import { theme } from '../src/tui/theme.js'
import type { SessionRecord, TaskDisplayItem } from '../src/harness/types.js'

test('recordsToDisplayItems preserves tool error codes for TUI rendering', () => {
  const records: SessionRecord[] = [
    {
      id: 'call-1',
      type: 'tool_use',
      tool: 'Bash',
      input: { command: 'exit 7' },
      riskLevel: 'dangerous',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'result-1',
      type: 'tool_result',
      toolUseId: 'call-1',
      tool: 'Bash',
      ok: false,
      content: '(no output)',
      errorCode: 'command_failed',
      createdAt: '2026-05-24T00:00:01.000Z',
    },
  ]

  const toolCall = recordsToDisplayItems(records).find((item) => item.kind === 'tool_call')
  assert.equal(toolCall?.kind, 'tool_call')
  assert.equal(toolCall?.status, 'error')
  assert.equal(toolCall?.errorCode, 'command_failed')
})

test('recordsToDisplayItems surfaces compact attempt failures', () => {
  const records: SessionRecord[] = [{
    id: 'compact-failed-1',
    type: 'compact_attempt_failed',
    error: 'compact summarizer failed',
    failureCount: 1,
    circuitOpen: false,
    preTokens: 12345,
    createdAt: '2026-05-24T00:00:00.000Z',
  }]

  const item = recordsToDisplayItems(records).find((candidate) => candidate.kind === 'compact_attempt_failed')
  assert.equal(item?.kind, 'compact_attempt_failed')
  assert.equal(item?.record.error, 'compact summarizer failed')
})

test('recordsToDisplayItems preserves structured tool result display metadata', () => {
  const records: SessionRecord[] = [
    {
      id: 'call-1',
      type: 'tool_use',
      tool: 'Read',
      input: { filePath: 'a.txt' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'result-1',
      type: 'tool_result',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'one\ntwo',
      display: { summary: 'Read 2 lines' },
      createdAt: '2026-05-24T00:00:01.000Z',
    },
  ]

  const toolCall = recordsToDisplayItems(records).find((item) => item.kind === 'tool_call')
  assert.equal(toolCall?.kind, 'tool_call')
  assert.deepEqual(toolCall?.resultDisplay, { summary: 'Read 2 lines' })
})

test('recordsToDisplayItems hides plan mode transition tool rows', () => {
  const records: SessionRecord[] = [
    {
      id: 'enter-1',
      type: 'tool_use',
      tool: 'EnterPlanMode',
      input: {},
      riskLevel: 'confirm',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'exit-1',
      type: 'tool_use',
      tool: 'ExitPlanMode',
      input: { plan: 'Do it' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:01.000Z',
    },
  ]

  assert.equal(recordsToDisplayItems(records).some((item) => item.kind === 'tool_call'), false)
})

test('recordsToDisplayItems hides task management tool rows', () => {
  const records: SessionRecord[] = [
    {
      id: 'task-create-1',
      type: 'tool_use',
      tool: 'TaskCreate',
      input: { subject: 'Create project folder', description: '' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'task-create-result-1',
      type: 'tool_result',
      toolUseId: 'task-create-1',
      tool: 'TaskCreate',
      ok: true,
      content: 'Created task #1',
      createdAt: '2026-05-24T00:00:01.000Z',
    },
    {
      id: 'task-update-1',
      type: 'tool_use',
      tool: 'TaskUpdate',
      input: { taskId: '1', status: 'in_progress' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:02.000Z',
    },
    {
      id: 'task-update-result-1',
      type: 'tool_result',
      toolUseId: 'task-update-1',
      tool: 'TaskUpdate',
      ok: false,
      content: 'Task not found',
      errorCode: 'invalid_input',
      createdAt: '2026-05-24T00:00:03.000Z',
    },
  ]

  assert.equal(recordsToDisplayItems(records).some((item) => item.kind === 'tool_call'), false)
})

test('recordsToDisplayItems marks restored running subagents as interrupted', () => {
  const records: SessionRecord[] = [{
    id: 'subagent-task-1',
    type: 'subagent_task',
    agentId: 'agent-1',
    subagentType: 'explore',
    status: 'running',
    description: 'Explore files',
    task: 'Find files',
    createdAt: '2026-05-24T00:00:00.000Z',
  }]

  const item = recordsToDisplayItems(records).find((candidate) => candidate.kind === 'subagent_task')
  assert.equal(item?.kind, 'subagent_task')
  assert.equal(item?.record.status, 'interrupted')
  assert.match(item ? formatSubagentTaskLine(item) : '', /explore agent[\s\S]*Interrupted/)
})

test('recordsToDisplayItems merges subagent lifecycle records into latest status row', () => {
  const records: SessionRecord[] = [
    {
      id: 'subagent-task-1',
      type: 'subagent_task',
      agentId: 'agent-1',
      subagentType: 'plan',
      status: 'running',
      description: 'Plan changes',
      task: 'Plan',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'subagent-task-2',
      type: 'subagent_task',
      agentId: 'agent-1',
      subagentType: 'plan',
      status: 'completed',
      description: 'Plan changes',
      task: 'Plan',
      summary: 'Done',
      transcriptPath: '/tmp/transcript.jsonl',
      createdAt: '2026-05-24T00:00:01.000Z',
    },
  ]

  const items = recordsToDisplayItems(records).filter((candidate) => candidate.kind === 'subagent_task')
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item?.kind, 'subagent_task')
  assert.equal(item?.record.status, 'completed')
  assert.match(item ? formatSubagentTaskLine(item) : '', /plan agent[\s\S]*Done/)
  assert.match(item ? formatSubagentTaskLine(item) : '', /\/agents show agent-1/)
})

test('tool display metadata comes from tool definitions', () => {
  assert.deepEqual(getToolDisplay('Glob', { pattern: '**/*.ts', path: 'src' }), {
    name: 'Search',
    summary: 'pattern: "**/*.ts", path: "src"',
  })
  assert.deepEqual(getToolDisplay('Agent', { subagent_type: 'plan', task: 'Design the change' }), {
    name: 'plan agent',
    summary: 'plan: Design the change',
  })
  assert.equal(getToolActivityDescription('Read', { filePath: 'src/tools/readFile.ts' }), 'Reading src/tools/readFile.ts')
  assert.equal(shouldDisplayToolResult('Read', { filePath: 'x' }, 'content'), true)
  assert.equal(shouldDisplayToolResult('Write', { filePath: 'x' }, 'Wrote x'), true)
  assert.equal(shouldDisplayToolResult('Delete', { filePath: 'x' }, 'Deleted x'), true)
})

test('tool status indicator uses Claude-style circle for all states', () => {
  for (const status of ['pending', 'running', 'approved', 'denied', 'done', 'error'] as const) {
    assert.equal(getStatusDot(status).char, '●')
  }
})

test('task list visual markers use Claude-style task status icons', () => {
  const base: TaskDisplayItem = {
    id: '1',
    status: 'pending',
    subject: 'Ship UI',
    description: '',
    blocks: [],
    blockedBy: [],
  }

  assert.deepEqual(getTaskVisual({ ...base, status: 'completed' }, false), {
    icon: '✔',
    iconColor: theme.codeInline,
    textColor: theme.dimText,
    bold: false,
    dim: true,
    strikethrough: true,
  })
  assert.deepEqual(getTaskVisual({ ...base, status: 'in_progress' }, false), {
    icon: '■',
    iconColor: theme.spinner,
    textColor: theme.assistantText,
    bold: true,
    dim: false,
    strikethrough: false,
  })
  assert.deepEqual(getTaskVisual(base, true), {
    icon: '□',
    iconColor: theme.dimText,
    textColor: theme.dimText,
    bold: false,
    dim: true,
    strikethrough: false,
  })
})

test('tool call running description uses tool-owned activity text', () => {
  assert.equal(
    formatToolCallRunningDescription('Bash', { command: 'npm test' }),
    'Running npm test',
  )
  assert.equal(
    formatToolCallRunningDescription('Read', { filePath: 'src/tools/readFile.ts' }),
    'Reading src/tools/readFile.ts',
  )
  assert.equal(formatToolCallRunningDescription('UnknownTool', {}), 'running...')
})
