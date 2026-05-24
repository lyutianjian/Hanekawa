import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSessionInvariants } from '../src/sessions/invariants.js'
import type { SessionRecord } from '../src/harness/types.js'

test('checkSessionInvariants leaves orphan tool records to request preparation repair', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Grep',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
      turnId: 'turn-1',
    },
    {
      type: 'tool_result',
      id: 'result-2',
      toolUseId: 'missing-call',
      tool: 'Grep',
      ok: false,
      content: 'missing',
      createdAt: '2026-05-10T00:00:01.000Z',
      turnId: 'turn-1',
    },
  ]

  const diagnostics = checkSessionInvariants(records)
  assert.equal(diagnostics.length, 0)
})

test('checkSessionInvariants reports tool results before tool use and turn mismatches', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_result',
      id: 'result-1',
      toolUseId: 'call-1',
      tool: 'Grep',
      ok: true,
      content: 'match',
      createdAt: '2026-05-10T00:00:00.000Z',
      turnId: 'turn-2',
    },
    {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Grep',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:01.000Z',
      turnId: 'turn-1',
    },
  ]

  const diagnostics = checkSessionInvariants(records)
  assert.ok(diagnostics.some((diagnostic) => (
    diagnostic.code === 'tool_result_before_use' && diagnostic.severity === 'info'
  )))
  assert.ok(diagnostics.some((diagnostic) => (
    diagnostic.code === 'turn_mismatch' && diagnostic.severity === 'warning'
  )))
})

test('checkSessionInvariants reports missing checkpoint messages and legacy turn metadata', () => {
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'msg-1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]

  const diagnostics = checkSessionInvariants(records, {
    checkpoints: [{ messageId: 'msg-missing', commitHash: 'hash', createdAt: '2026-05-10T00:00:01.000Z' }],
  })

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'checkpoint_missing_message'))
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'legacy_missing_turn_id'))
})
