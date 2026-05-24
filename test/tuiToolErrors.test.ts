import test from 'node:test'
import assert from 'node:assert/strict'
import { recordsToDisplayItems } from '../src/tui/hooks/useAgentLoop.js'
import type { SessionRecord } from '../src/harness/types.js'

test('recordsToDisplayItems preserves tool error codes for TUI rendering', () => {
  const records: SessionRecord[] = [
    {
      id: 'call-1',
      type: 'tool_use',
      tool: 'bash',
      input: { command: 'exit 7' },
      riskLevel: 'dangerous',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'result-1',
      type: 'tool_result',
      toolUseId: 'call-1',
      tool: 'bash',
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
