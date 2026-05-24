import test from 'node:test'
import assert from 'node:assert/strict'
import { recordsToDisplayItems } from '../src/tui/hooks/useAgentLoop.js'
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
