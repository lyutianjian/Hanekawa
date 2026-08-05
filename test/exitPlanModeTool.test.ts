import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { exitPlanModeTool } from '../src/tools/exitPlanMode.js'
import type { PlanModeBridge, SessionRecord, ToolContext } from '../src/harness/types.js'

function makeBridge(sessionId: string, records: SessionRecord[], planFilePath?: string): PlanModeBridge {
  return {
    parentSessionId: sessionId,
    parentAppendRecord: async (record) => { records.push(record) },
    activePlanFilePath: planFilePath,
  }
}

test('ExitPlanMode description includes approval contract', () => {
  assert.match(exitPlanModeTool.description, /Use this tool when you are in plan mode and have finished writing your plan/)
  assert.match(exitPlanModeTool.description, /ready for user approval/)
  assert.match(exitPlanModeTool.description, /reads the plan from the file you wrote/)
  assert.match(exitPlanModeTool.description, /ExitPlanMode inherently requests user approval/)
})

test('exitPlanMode emits a plan_mode_request record when plan file exists', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-exitplan-'))
  try {
    const planFile = path.join(cwd, 'plan.md')
    await writeFile(planFile, '# My Plan\n- Step 1\n- Step 2', 'utf-8')

    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
    const runner = new ToolRunner([exitPlanModeTool], gate, {
      onRecord: async (record) => { records.push(record) },
    })
    const bridge = makeBridge('session', records, planFile)
    const context: ToolContext = {
      cwd,
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
    assert.equal(gate.getMode(), 'plan')
    const requestRecord = records.find(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
        r.type === 'plan_mode_request',
    )
    assert.ok(requestRecord, 'should emit a plan_mode_request record')
    assert.equal(requestRecord.kind, 'exit')
    assert.equal(requestRecord.submittedFromSessionId, 'session')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('exitPlanMode succeeds with no plan file and no inline plan (CC-aligned: empty plan proceeds to dialog)', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-exitplan-'))
  try {
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
    const runner = new ToolRunner([exitPlanModeTool], gate, {
      onRecord: async (record) => { records.push(record) },
    })
    const bridge = makeBridge('session', records, path.join(cwd, 'nonexistent.md'))
    const context: ToolContext = {
      cwd,
      sessionId: 'session',
      readFiles: new Set(),
      planModeBridge: bridge,
    }

    const result = await runner.run({
      id: 'call-1',
      name: 'ExitPlanMode',
      input: {},
    }, context)

    // Aligned with CC: plan content is optional. The exit dialog opens
    // regardless — the user sees an empty plan and can reject if desired.
    assert.equal(result.ok, true)
    const requestRecord = records.find(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
        r.type === 'plan_mode_request',
    )
    assert.ok(requestRecord, 'should emit a plan_mode_request record')
    assert.equal(requestRecord.kind, 'exit')
    assert.equal(requestRecord.planContent, undefined, 'no inline plan when none provided')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('exitPlanMode succeeds with inline plan when plan file does not exist', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-exitplan-'))
  try {
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => false, undefined, { mode: 'plan' })
    const runner = new ToolRunner([exitPlanModeTool], gate, {
      onRecord: async (record) => { records.push(record) },
    })
    const bridge = makeBridge('session', records, path.join(cwd, 'nonexistent.md'))
    const context: ToolContext = {
      cwd,
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
    assert.equal(gate.getMode(), 'plan')
    const requestRecord = records.find(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
        r.type === 'plan_mode_request',
    )
    assert.ok(requestRecord, 'should emit a plan_mode_request record')
    assert.equal(requestRecord.kind, 'exit')
    assert.equal(requestRecord.planContent, '1. Inspect.\n2. Patch.\n3. Test.')
    assert.equal(requestRecord.submittedFromSessionId, 'session')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
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
    input: {},
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
    input: {},
  }, context)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.equal(result.content, 'Plan mode is not available in this context.')
})
