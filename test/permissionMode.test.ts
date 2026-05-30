import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate, type PermissionMode } from '../src/harness/permissions.js'
import type { PlanModeManager } from '../src/harness/planModeManager.js'
import {
  applyPermissionModeTransition,
  nextPermissionMode,
  permissionModeStatusLabel,
  permissionModeTitle,
  syncPlanModeManagerForPermissionModeChange,
} from '../src/tui/permissionMode.js'

function managerSpy() {
  const calls: string[] = []
  const manager = {
    onEnterPlanMode: () => { calls.push('enter') },
    onExitPlanMode: () => { calls.push('exit') },
  } as unknown as PlanModeManager
  return { manager, calls }
}

test('permission mode cycle includes plan and excludes bypass', () => {
  assert.equal(nextPermissionMode('default', 1), 'acceptEdits')
  assert.equal(nextPermissionMode('acceptEdits', 1), 'plan')
  assert.equal(nextPermissionMode('plan', 1), 'auto')
  assert.equal(nextPermissionMode('auto', 1), 'default')
  assert.equal(nextPermissionMode('bypass', 1), 'acceptEdits')
})

test('permission mode display labels keep acceptEdits distinct from auto', () => {
  assert.equal(permissionModeStatusLabel('acceptEdits'), 'accept-edits')
  assert.equal(permissionModeTitle('acceptEdits'), 'Accept edits')
  assert.equal(permissionModeStatusLabel('auto'), 'auto')
  assert.equal(permissionModeTitle('auto'), 'Auto')
})

test('applying transition into plan mode activates PlanModeManager and stashes prior mode', () => {
  const gate = new PermissionGate(async () => true, undefined, { mode: 'acceptEdits' })
  const { manager, calls } = managerSpy()

  const mode = applyPermissionModeTransition(gate, manager, 'plan')

  assert.equal(mode, 'plan')
  assert.equal(gate.getMode(), 'plan')
  assert.equal(gate.getPrePlanMode(), 'acceptEdits')
  assert.deepEqual(calls, ['enter'])
})

test('applying transition out of plan mode deactivates PlanModeManager', () => {
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default' })
  const { manager, calls } = managerSpy()
  gate.prepareContextForPlanMode()

  const mode = applyPermissionModeTransition(gate, manager, 'auto')

  assert.equal(mode, 'auto')
  assert.equal(gate.getMode(), 'auto')
  assert.deepEqual(calls, ['exit'])
})

test('mode-change listener sync handles raw gate.setMode calls such as /bypass', () => {
  const { manager, calls } = managerSpy()
  syncPlanModeManagerForPermissionModeChange(manager, 'default', 'plan')
  syncPlanModeManagerForPermissionModeChange(manager, 'plan', 'bypass')
  syncPlanModeManagerForPermissionModeChange(manager, 'bypass' as PermissionMode, 'default')

  assert.deepEqual(calls, ['enter', 'exit'])
})
