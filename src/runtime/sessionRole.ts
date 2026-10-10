import type { CoordinationRole, Tool } from '../harness/types.js'
import type { PermissionMode } from '../harness/permissions.js'
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from '../tools/toolNames.js'

/** The coordination role recorded in a session's meta; undefined for a normal session. */
export function sessionRoleOf(
  meta: { coordination?: { role: CoordinationRole } } | undefined,
): CoordinationRole | undefined {
  return meta?.coordination?.role
}

/** Coordinators start read-only, threads start in auto; others keep the settings mode. */
export function initialPermissionMode(
  role: CoordinationRole | undefined,
  settingsMode: PermissionMode,
): PermissionMode {
  if (role === 'coordinator') return 'readonly'
  if (role === 'thread') return 'auto'
  return settingsMode
}

const COORDINATOR_HIDDEN = new Set([ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME])

/** Whether `tool` is offered to a session of `role` (undefined = normal session). */
export function toolAvailableForRole(
  tool: Pick<Tool, 'name' | 'sessionRoles'>,
  role: CoordinationRole | undefined,
): boolean {
  if (tool.sessionRoles && (!role || !tool.sessionRoles.includes(role))) return false
  if (role === 'coordinator' && COORDINATOR_HIDDEN.has(tool.name)) return false
  return true
}
