import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { exitPlanModeTool } from '../src/tools/exitPlanMode.js'
import type { PlanModeBridge, SessionRecord, ToolContext } from '../src/harness/types.js'

function makeBridge(sessionId: string, records: SessionRecord[]): PlanModeBridge {
  return {
    parentSessionId: sessionId,
    parentAppendRecord: async (record) => { records.push(record) },
  }
}

test('ExitPlanMode description includes Claude Code approval contract', () => {
  assert.match(exitPlanModeTool.description, /Use this tool when you are in plan mode and have finished writing your plan/)
  assert.match(exitPlanModeTool.description, /ready for user approval/)
  assert.match(exitPlanModeTool.description, /does NOT take the plan content as a parameter/)
  assert.match(exitPlanModeTool.description, /Do NOT use AskUserQuestion to ask "Is this plan okay\?"/)
  assert.match(exitPlanModeTool.description, /ExitPlanMode inherently requests user approval/)
})

test('exitPlanMode emits a plan_mode_request record with inline plan', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const bridge = makeBridge('session', records)
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
    planModeBridge: bridge,
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: { plan: '1. Inspect.\n2. Patch.\n3. Test.' },
  }, context)

  assert.equal(result.ok, true)
  // Mode is NOT changed directly — PlanModeManager handles that.
  assert.equal(gate.getMode(), 'plan')
  // Should emit a plan_mode_request record with the inline plan.
  const requestRecord = records.find(
    (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
      r.type === 'plan_mode_request',
  )
  assert.ok(requestRecord, 'should emit a plan_mode_request record')
  assert.equal(requestRecord.kind, 'exit')
  assert.equal(requestRecord.planContent, '1. Inspect.\n2. Patch.\n3. Test.')
  assert.equal(requestRecord.submittedFromSessionId, 'session')
})

test('exitPlanMode emits a plan_mode_request without planContent when plan is omitted', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const bridge = makeBridge('session', records)
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
    planModeBridge: bridge,
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: {},
  }, context)

  assert.equal(result.ok, true)
  const requestRecord = records.find(
    (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
      r.type === 'plan_mode_request',
  )
  assert.ok(requestRecord, 'should emit a plan_mode_request record')
  assert.equal(requestRecord.kind, 'exit')
  assert.equal(requestRecord.planContent, undefined, 'no inline plan when omitted')
})

test('exitPlanMode fails outside plan mode', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => false, undefined, { mode: 'default' })
  const runner = new ToolRunner([exitPlanModeTool], gate, {
    onRecord: async (record) => {
      records.push(record)
    },
  })
  const bridge = makeBridge('session', records)
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'session',
    readFiles: new Set(),
    planModeBridge: bridge,
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
  assert.equal(records.some((r) => r.type === 'plan_mode_request'), false)
})

test('exitPlanMode fails without planModeBridge', async () => {
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
    // No planModeBridge
  }

  const result = await runner.run({
    id: 'call-1',
    name: 'ExitPlanMode',
    input: { plan: 'test plan' },
  }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.equal(result.content, 'Plan mode is not available in this context.')
})
