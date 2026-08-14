import type { PermissionGate, PermissionMode } from '../harness/permissions.js'
import type { PlanModeManager } from '../harness/planModeManager.js'

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']

export function nextPermissionMode(currentMode: PermissionMode, direction: 1 | -1): PermissionMode {
  const index = PERMISSION_MODES.indexOf(currentMode)
  const normalizedIndex = index >= 0 ? index : PERMISSION_MODES.indexOf('default')
  const nextIndex = (normalizedIndex + direction + PERMISSION_MODES.length) % PERMISSION_MODES.length
  return PERMISSION_MODES[nextIndex] ?? 'default'
}

export function syncPlanModeManagerForPermissionModeChange(
  manager: PlanModeManager | undefined,
  previousMode: PermissionMode,
  nextMode: PermissionMode,
): void {
  if (nextMode === 'plan') {
    manager?.onEnterPlanMode()
  } else if (previousMode === 'plan') {
    manager?.onExitPlanMode()
  }
}

export function applyPermissionModeTransition(
  gate: PermissionGate,
  manager: PlanModeManager | undefined,
  nextMode: PermissionMode,
): PermissionMode {
  const previousMode = gate.getMode()
  if (nextMode === 'plan') {
    gate.prepareContextForPlanMode()
  } else {
    gate.setMode(nextMode)
  }
  const actualMode = gate.getMode()
  syncPlanModeManagerForPermissionModeChange(manager, previousMode, actualMode)
  return actualMode
}
