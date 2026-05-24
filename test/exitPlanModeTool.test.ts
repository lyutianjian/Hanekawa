import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { exitPlanModeTool } from '../src/tools/exitPlanMode.js'
import type { SessionRecord, ToolContext } from '../src/harness/types.js'

test('exitPlanMode appends the plan and restores the pre-plan permission mode', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'acceptEdits' })
  gate.setMode('plan')
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: { plan: '1. Inspect.\n2. Patch.\n3. Test.' },
  }, context)

  assert.equal(result.ok, true)
  assert.equal(gate.getMode(), 'acceptEdits')
  assert.equal(records.some((record) => record.type === 'tool_approval' && record.approved), true)
  assert.deepEqual(records.map((record) => record.type), ['tool_use', 'tool_approval', 'tool_result', 'message'])
  const planRecord = records.find(
    (record): record is Extract<SessionRecord, { type: 'message' }> =>
      record.type === 'message' && record.role === 'assistant',
  )
  assert.ok(planRecord)
  assert.equal(planRecord.content, '1. Inspect.\n2. Patch.\n3. Test.')
})

test('exitPlanMode fails outside plan mode without appending a plan message', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'default' })
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: { plan: '1. This should not be emitted.' },
  }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.equal(result.content, 'ExitPlanMode can only be called in plan mode.')
  assert.equal(gate.getMode(), 'default')
  assert.equal(records.some((record) => record.type === 'message'), false)
})

test('exitPlanMode rejects a blank plan without appending a plan message', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: { plan: '   \n\t  ' },
  }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.equal(result.content, 'Plan must not be empty.')
  assert.equal(gate.getMode(), 'plan')
  assert.equal(records.some((record) => record.type === 'message'), false)
})
