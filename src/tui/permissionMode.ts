import type { PermissionMode } from '../harness/permissions.js'

export function permissionModeStatusLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'accept-edits'
    case 'bypass':
      return 'bypass'
    case 'plan':
      return 'plan'
    case 'default':
    default:
      return 'default'
  }
}

export function permissionModeTitle(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return 'Accept edits'
    case 'bypass':
      return 'Bypass'
    case 'plan':
      return 'Plan'
    case 'default':
    default:
      return 'Default'
  }
}
