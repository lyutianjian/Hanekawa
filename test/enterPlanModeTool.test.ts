import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { enterPlanModeTool } from '../src/tools/enterPlanMode.js'
import { filterToolsForSubAgent, BUILT_IN_AGENT_DEFINITIONS } from '../src/tools/agentTool.js'
import type { PlanModeBridge, SessionRecord, ToolContext } from '../src/harness/types.js'

function makeBridge(parentSessionId: string, parentRecords: SessionRecord[]): PlanModeBridge {
  return {
    parentSessionId,
    parentAppendRecord: async (record) => { parentRecords.push(record) },
  }
}

test('EnterPlanMode description includes Claude Code plan workflow', () => {
  assert.match(enterPlanModeTool.description, /## What Happens in Plan Mode/)
  assert.match(enterPlanModeTool.description, /Use AskUserQuestion if you need to clarify approaches/)
  assert.match(enterPlanModeTool.description, /Exit plan mode with ExitPlanMode when ready to implement/)
})

test('EnterPlanMode in default mode emits plan_mode_request kind="enter"', async () => {
  const parentRecords: SessionRecord[] = []
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default' })
  const runner = new ToolRunner([enterPlanModeTool], gate, {
    onRecord: async (record) => { records.push(record) },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'main-session',
    readFiles: new Set(),
    planModeBridge: makeBridge('main-session', parentRecords),
  }

  const result = await runner.run({ id: 'call-1', name: 'EnterPlanMode', input: {} }, context)

  assert.equal(result.ok, true)
  const requests = parentRecords.filter((r) => r.type === 'plan_mode_request')
  assert.equal(requests.length, 1)
  const req = requests[0]
  assert.ok(req && req.type === 'plan_mode_request')
  assert.equal(req.kind, 'enter')
  assert.equal(req.submittedFromSessionId, 'main-session')
})

test('EnterPlanMode in plan mode returns precondition_failed without emitting a record', async () => {
  const parentRecords: SessionRecord[] = []
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'plan' })
  const runner = new ToolRunner([enterPlanModeTool], gate, {
    onRecord: async (record) => { records.push(record) },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'main-session',
    readFiles: new Set(),
    planModeBridge: makeBridge('main-session', parentRecords),
  }

  const result = await runner.run({ id: 'call-1', name: 'EnterPlanMode', input: {} }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.equal(parentRecords.length, 0)
})

test('EnterPlanMode without planModeBridge returns precondition_failed', async () => {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default' })
  const runner = new ToolRunner([enterPlanModeTool], gate, {
    onRecord: async (record) => { records.push(record) },
  })
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: 'main-session',
    readFiles: new Set(),
    // No planModeBridge configured.
  }

  const result = await runner.run({ id: 'call-1', name: 'EnterPlanMode', input: {} }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
})

test('filterToolsForSubAgent excludes EnterPlanMode for all built-in agents', () => {
  const fakeTools = [enterPlanModeTool]
  for (const definition of BUILT_IN_AGENT_DEFINITIONS) {
    const filtered = filterToolsForSubAgent([...fakeTools], definition)
    assert.equal(
      filtered.find((t) => t.name === 'EnterPlanMode'),
      undefined,
      `built-in agent ${definition.type} should not see EnterPlanMode`,
    )
  }
})

test('filterToolsForSubAgent excludes ExitPlanMode even when explicitly listed', async () => {
  const { exitPlanModeTool } = await import('../src/tools/exitPlanMode.js')
  const fakeTools = [exitPlanModeTool]
  for (const definition of BUILT_IN_AGENT_DEFINITIONS) {
    const filtered = filterToolsForSubAgent([...fakeTools], definition)
    assert.equal(
      filtered.find((t) => t.name === 'ExitPlanMode'),
      undefined,
      `built-in agent ${definition.type} should not see ExitPlanMode by default`,
    )
  }

  const customAgent = {
    type: 'custom-planner',
    description: 'a custom plan-submitter',
    tools: ['Read', 'Write', 'ExitPlanMode'],
    disallowedTools: ['Agent', 'EnterPlanMode'],
    maxTurns: 10,
    isReadOnlyAgent: false,
    getSystemPrompt: () => 'custom',
  }
  const filteredCustom = filterToolsForSubAgent([...fakeTools], customAgent)
  assert.equal(
    filteredCustom.find((t) => t.name === 'ExitPlanMode'),
    undefined,
    'custom agent with explicit ExitPlanMode in tools should still not see it',
  )
})
