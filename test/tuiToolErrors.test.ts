import test from 'node:test'
import assert from 'node:assert/strict'
import { recordsToDisplayItems } from '../src/tui/hooks/useAgentLoop.js'
import { formatToolCallRunningDescription, getStatusDot } from '../src/tui/components/ToolCallBlock.js'
import { getToolActivityDescription, getToolDisplay, shouldDisplayToolResult } from '../src/tools/display.js'
import type { SessionRecord } from '../src/harness/types.js'

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

test('tool display metadata comes from tool definitions', () => {
  assert.deepEqual(getToolDisplay('Glob', { pattern: '**/*.ts', path: 'src' }), {
    name: 'Search',
    summary: 'pattern: "**/*.ts", path: "src"',
  })
  assert.deepEqual(getToolDisplay('TodoWrite', { todos: [{ content: 'Ship it', status: 'pending' }] }), {
    name: 'Todo',
    summary: '1 item',
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
