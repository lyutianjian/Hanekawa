import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PermissionGate } from '../src/harness/permissions.js'
import { PlanModeManager } from '../src/harness/planModeManager.js'
import { SessionStore } from '../src/sessions/service.js'
import { clearAllPlanSlugs, readPlan, writePlan } from '../src/utils/plans.js'
import type { SessionRecord } from '../src/harness/types.js'

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-planmgr-'))
  try {
    clearAllPlanSlugs()
    return await fn(dir)
  } finally {
    clearAllPlanSlugs()
    await rm(dir, { recursive: true, force: true })
  }
}

async function setup(cwd: string) {
  const store = new SessionStore(cwd)
  await store.init()
  const meta = await store.create()
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default', cwd })
  const manager = new PlanModeManager({
    cwd,
    sessionMeta: meta,
    store,
    gate,
    appendRecord: async (record) => { records.push(record) },
  })
  // Mirror tui.tsx wiring.
  gate.setPlanSlugProvider(() => manager.getSlug())
  return { store, meta, gate, manager, records }
}

test('onEnterPlanMode flips state.active without creating a file or generating a slug', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    assert.equal(manager.isActive(), false)
    assert.equal(manager.getSlug(), undefined, 'no slug before any path resolution')
    await manager.onEnterPlanMode()
    assert.equal(manager.isActive(), true)
    assert.equal(manager.getSlug(), undefined, 'slug still lazy after onEnterPlanMode')
    assert.equal(manager.getActivePlanFilePath(), undefined, 'no path until lazy resolution')
  })
})

test('resolvePlanFilePathLazy generates the slug on demand', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    assert.match(planPath, /[/\\]\.myagent[/\\]plans[/\\][a-z]+-[a-z]+-[a-z]+\.md$/)
    const slug = manager.getSlug()
    assert.ok(slug)
    assert.ok(planPath.includes(slug!))
    // Active path now resolvable since slug exists.
    assert.equal(manager.getActivePlanFilePath(), planPath)
  })
})

test('onExitPlanMode flips state and queues exit reminder', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    await manager.onEnterPlanMode()
    manager.resolvePlanFilePathLazy()
    await manager.onExitPlanMode()
    assert.equal(manager.isActive(), false)
    assert.equal(manager.getActivePlanFilePath(), undefined, 'inactive returns undefined')
    // Slug is preserved (in-memory) for re-entry within same session.
    assert.ok(manager.getSlug())
  })
})

test('re-entering plan mode in same session reuses the existing slug', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    await manager.onEnterPlanMode()
    const slugFirst = manager.resolvePlanFilePathLazy()
    await manager.onExitPlanMode()
    await manager.onEnterPlanMode()
    const slugSecond = manager.resolvePlanFilePathLazy()
    assert.equal(slugFirst, slugSecond, 'slug stable across exit/re-entry')
  })
})

test('onSessionLoaded is a no-op (no state change)', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    await manager.onSessionLoaded()
    assert.equal(manager.isActive(), false)
    assert.equal(manager.getSlug(), undefined)
  })
})

test('buildBridge returns a bridge whose activePlanFilePath getter is live', async () => {
  await withTempCwd(async (cwd) => {
    const { manager, meta } = await setup(cwd)
    const bridge = manager.buildBridge()
    assert.equal(bridge.parentSessionId, meta.id)
    assert.equal(bridge.activePlanFilePath, undefined, 'no path before slug')
    await manager.onEnterPlanMode()
    manager.resolvePlanFilePathLazy()
    assert.match(bridge.activePlanFilePath ?? '', /\.myagent[/\\]plans[/\\][a-z]+-[a-z]+-[a-z]+\.md$/)
  })
})

test('getPlanFileReferenceForCompaction returns reminder when active+non-empty', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan body\n')
    const reminder = await manager.getPlanFileReferenceForCompaction()
    assert.ok(reminder)
    assert.match(reminder!, /Plan body/)
  })
})

test('getPlanFileReferenceForCompaction returns undefined when inactive', async () => {
  await withTempCwd(async (cwd) => {
    const { manager } = await setup(cwd)
    const reminder = await manager.getPlanFileReferenceForCompaction()
    assert.equal(reminder, undefined)
  })
})

test('drainRequests handles enter approved (calls openEnterPrompt + appendRecord enter_approved)', async () => {
  await withTempCwd(async (cwd) => {
    const { manager, records, gate, meta } = await setup(cwd)
    let promptCalled = false
    manager.setUiDeps({
      openEnterPrompt: async () => { promptCalled = true; return true },
    })
    // Simulate the EnterPlanMode tool emitting a request record.
    records.push({
      id: 'req-1',
      type: 'plan_mode_request',
      kind: 'enter',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    // The manager reads from records when loadRecords is provided. Inject it:
    const m2 = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: (await setup(cwd)).store, // dummy
      gate,
      appendRecord: async (r) => { records.push(r) },
      loadRecords: async () => [...records],
    })
    m2.setUiDeps({ openEnterPrompt: async () => { promptCalled = true; return true } })
    gate.setPlanSlugProvider(() => m2.getSlug())
    await m2.beforeTurn()
    assert.equal(promptCalled, true)
    assert.equal(m2.isActive(), true)
    const approved = records.find((r) => r.type === 'plan_mode_outcome' && r.kind === 'enter_approved')
    assert.ok(approved)
  })
})

test('drainRequests handles exit with empty plan: opens dialog and can approve exit', async () => {
  await withTempCwd(async (cwd) => {
    const { manager, records, gate, meta } = await setup(cwd)
    await manager.onEnterPlanMode()
    let dialogOpened = false
    manager.setUiDeps({
      openExitDialog: async () => {
        dialogOpened = true
        return { kind: 'reject', feedback: '' }
      },
    })
    // No plan file written. Emit exit request.
    const localRecords: SessionRecord[] = [{
      id: 'req-exit-empty',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    }]
    const m = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: (await setup(cwd)).store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
    })
    m.setUiDeps({ openExitDialog: async () => { dialogOpened = true; return { kind: 'approve_restore_keep' } } })
    await m.onEnterPlanMode()
    await m.beforeTurn()
    assert.equal(dialogOpened, true, 'empty plan should open dialog')
    const approved = localRecords.find(
      (r) => r.type === 'plan_mode_outcome' && r.kind === 'exit_approved',
    )
    assert.ok(approved)
    void records
  })
})

test('drainRequests handles exit with inline plan: writes to disk + opens dialog with critique findings', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    let dialogInput: { planContent: string; planFilePath: string; finalCritique?: { findings: string } } | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.setUiDeps({
      runCritiqueAgent: async () => ({ findings: 'consider edge case X' }),
      openExitDialog: async (input) => {
        dialogInput = input
        return { kind: 'approve_restore_keep' }
      },
    })
    await manager.onEnterPlanMode()
    // Emit an exit request with inline plan.
    localRecords.push({
      id: 'req-exit-inline',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      planContent: '# Inline plan body\n',
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()
    assert.ok(dialogInput, 'dialog should open')
    assert.equal(dialogInput!.planContent, '# Inline plan body\n')
    assert.equal(dialogInput!.finalCritique?.findings, 'consider edge case X')
    const approved = localRecords.find(
      (r) => r.type === 'plan_mode_outcome' && r.kind === 'exit_approved',
    )
    assert.ok(approved)
    // Mode restored.
    assert.equal(manager.isActive(), false)
  })
})

test('approved dialog edits replace disk plan, exit attachment, and clear-context prompt', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const clearContextCalls: string[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({
        kind: 'approve_clear_restore_with_plan_as_prompt',
        planContent: '# Edited by user\n',
      }),
      onClearContextAndReplaceInput: async (content) => {
        clearContextCalls.push(content)
      },
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Original\n')
    localRecords.push({
      id: 'req-exit-edited',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })

    await manager.beforeTurn()

    assert.equal(await readPlan(planPath), '# Edited by user\n')
    assert.deepEqual(clearContextCalls, ['Implement the following plan:\n\n# Edited by user\n'])
    const exitAttachment = manager.getActivePlanAttachment()
    assert.match(exitAttachment ?? '', /# Edited by user/)
    assert.doesNotMatch(exitAttachment ?? '', /Implement the following plan/)
    assert.doesNotMatch(exitAttachment ?? '', /# Original/)
  })
})

test('approve_clear_restore_with_plan_as_prompt requests current turn stop exactly once', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({ kind: 'approve_clear_restore_with_plan_as_prompt' }),
      onClearContextAndReplaceInput: async () => {},
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Restart here\n')
    localRecords.push({
      id: 'req-stop-current-turn',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })

    await manager.beforeTurn()

    assert.equal(manager.consumeShouldStopCurrentTurn(), true)
    assert.equal(manager.consumeShouldStopCurrentTurn(), false)
  })
})

test('approve_acceptEdits_keep maps auto-accept edits approval to acceptEdits mode', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({ kind: 'approve_acceptEdits_keep' }),
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan body\n')
    localRecords.push({
      id: 'req-exit-accept-edits-keep',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })

    await manager.beforeTurn()

    assert.equal(gate.getMode(), 'acceptEdits')
    assert.equal(manager.isActive(), false)
  })
})

test('approve_restore_keep maps manually approve edits approval to default mode', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({ kind: 'approve_restore_keep' }),
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    gate.setMode('acceptEdits')
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan body\n')
    localRecords.push({
      id: 'req-exit-manual-keep',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })

    await manager.beforeTurn()

    assert.equal(gate.getMode(), 'default')
    assert.equal(manager.isActive(), false)
  })
})

test('drainRequests is idempotent: already-handled requestId is skipped', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    let promptCount = 0
    const localRecords: SessionRecord[] = [{
      id: 'req-idempotent',
      type: 'plan_mode_request',
      kind: 'enter',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    }]
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.setUiDeps({
      openEnterPrompt: async () => { promptCount += 1; return true },
    })
    await manager.beforeTurn()
    await manager.beforeTurn() // second call should be no-op
    assert.equal(promptCount, 1, 'prompt called exactly once')
  })
})

test('subagent_exit kind routed identically to exit', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    let dialogOpened = false
    const localRecords: SessionRecord[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.setUiDeps({
      runCritiqueAgent: async () => ({ findings: 'fine' }),
      openExitDialog: async () => {
        dialogOpened = true
        return { kind: 'approve_restore_keep' }
      },
    })
    await manager.onEnterPlanMode()
    localRecords.push({
      id: 'req-sub',
      type: 'plan_mode_request',
      kind: 'subagent_exit',
      submittedFromSessionId: 'sub-agent-1',
      planContent: '# Sub plan\n',
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()
    assert.equal(dialogOpened, true)
  })
})

test('submitAssistantPlanFallback emits an exit request with inline plan content', async () => {
  await withTempCwd(async (cwd) => {
    const { manager, records, meta } = await setup(cwd)

    await manager.submitAssistantPlanFallback('# Assistant text plan\n', 'turn-fallback')

    const request = records.find(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
        r.type === 'plan_mode_request',
    )
    assert.ok(request)
    assert.equal(request.kind, 'exit')
    assert.equal(request.submittedFromSessionId, meta.id)
    assert.equal(request.planContent, '# Assistant text plan\n')
    assert.equal(request.turnId, 'turn-fallback')
  })
})


test('drainRequests handles enter rejected (appends enter_rejected outcome and emits reminder)', async () => {
  await withTempCwd(async (cwd) => {
    const { gate, meta } = await setup(cwd)
    const localRecords: SessionRecord[] = []
    const chatMessages: string[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: (await setup(cwd)).store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.setUiDeps({
      openEnterPrompt: async () => false,
      emitChatMessage: async (content) => { chatMessages.push(content) },
    })
    localRecords.push({
      id: 'req-enter-rejected',
      type: 'plan_mode_request',
      kind: 'enter',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()

    assert.equal(manager.isActive(), false, 'plan mode stays inactive on rejection')
    const outcome = localRecords.find(
      (r) => r.type === 'plan_mode_outcome' && r.kind === 'enter_rejected',
    )
    assert.ok(outcome, 'enter_rejected outcome appended')
    assert.equal(chatMessages.length, 1)
    assert.match(chatMessages[0]!, /declined to enter plan mode/)
  })
})

test('approve_bypass_keep flips gate to bypass and emits exit_approved', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({ kind: 'approve_bypass_keep' }),
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    // Simulate "user entered plan mode from bypass mode" so the dialog
    // would have surfaced bypass options.
    gate.setMode('bypass')
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan body\n')
    localRecords.push({
      id: 'req-exit-bypass-keep',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()

    assert.equal(gate.getMode(), 'bypass', 'gate is in bypass mode after approval')
    assert.equal(manager.isActive(), false, 'plan mode is exited')
    const outcome = localRecords.find(
      (r) => r.type === 'plan_mode_outcome' && r.kind === 'exit_approved',
    ) as Extract<SessionRecord, { type: 'plan_mode_outcome' }> | undefined
    assert.ok(outcome)
    assert.equal(outcome?.detail, 'approve_bypass_keep')
  })
})

test('approve_clear_bypass_with_plan_as_prompt clears context and sets bypass', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    const clearContextCalls: string[] = []
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async () => ({
        kind: 'approve_clear_bypass_with_plan_as_prompt',
        planContent: '# Approved plan\n',
      }),
      onClearContextAndReplaceInput: async (content) => {
        clearContextCalls.push(content)
      },
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    gate.setMode('bypass')
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Original\n')
    localRecords.push({
      id: 'req-exit-clear-bypass',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()

    assert.equal(gate.getMode(), 'bypass', 'gate flipped to bypass post-exit')
    assert.deepEqual(clearContextCalls, ['Implement the following plan:\n\n# Approved plan\n'])
    assert.equal(
      manager.consumeShouldStopCurrentTurn(),
      true,
      'turn-stop signal raised so the old loop bails before the new one starts',
    )
  })
})

test('openExitDialog receives isBypassAvailable=true when prePlanMode was bypass', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    let observedFlag: boolean | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async (input) => {
        observedFlag = input.isBypassAvailable
        return { kind: 'reject', feedback: '' }
      },
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    gate.setMode('bypass')
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan\n')
    localRecords.push({
      id: 'req-flag-bypass',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()

    assert.equal(observedFlag, true, 'dialog sees bypass-available flag from gate.getPrePlanMode()')
  })
})

test('openExitDialog receives isBypassAvailable=false when prePlanMode was not bypass', async () => {
  await withTempCwd(async (cwd) => {
    const setupResult = await setup(cwd)
    const { gate, meta } = setupResult
    const localRecords: SessionRecord[] = []
    let observedFlag: boolean | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: meta,
      store: setupResult.store,
      gate,
      appendRecord: async (r) => { localRecords.push(r) },
      loadRecords: async () => [...localRecords],
      openExitDialog: async (input) => {
        observedFlag = input.isBypassAvailable
        return { kind: 'reject', feedback: '' }
      },
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    // Default mode entry: prePlanMode is 'default', not 'bypass'.
    gate.prepareContextForPlanMode()
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan\n')
    localRecords.push({
      id: 'req-flag-default',
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: meta.id,
      createdAt: new Date().toISOString(),
    })
    await manager.beforeTurn()

    assert.equal(observedFlag, false, 'dialog sees bypass-unavailable for non-bypass entries')
  })
})
