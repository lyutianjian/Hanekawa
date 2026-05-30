import type { CommandDefinition } from './types.js'

/**
 * Toggle the bypass permission mode. Bypass is intentionally excluded from
 * the Tab cycle (see tui/permissionMode.ts PERMISSION_MODES) and must be enabled
 * explicitly because it is the highest-risk mode: protected paths still
 * prompt, but most tool calls run without confirmation.
 *
 * Usage:
 *   /bypass         -> toggle bypass on/off (off returns to default)
 *   /bypass on      -> enable bypass
 *   /bypass off     -> disable bypass (returns to default)
 */
export const bypassCommand: CommandDefinition = {
  name: 'bypass',
  description: 'Toggle bypass permission mode (high risk; off returns to default)',
  argumentHint: '[on|off]',
  run: async (args, context) => {
    if (!context.getPermissionMode || !context.setPermissionMode) {
      context.writeLine('Bypass mode is unavailable in this session.')
      return
    }

    const arg = args.trim().toLowerCase()
    const current = context.getPermissionMode()

    let nextEnabled: boolean
    if (arg === '' || arg === 'toggle') {
      nextEnabled = current !== 'bypass'
    } else if (arg === 'on' || arg === 'enable' || arg === 'true') {
      nextEnabled = true
    } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
      nextEnabled = false
    } else {
      context.writeLine(`Unknown argument: ${arg}. Usage: /bypass [on|off]`)
      return
    }

    if (nextEnabled) {
      if (current === 'bypass') {
        context.writeLine('Bypass mode is already enabled.')
        return
      }
      context.setPermissionMode('bypass')
      context.writeLine(
        'Bypass mode enabled. Most tool calls will run without confirmation; protected paths still prompt. Use /bypass off to disable.',
      )
    } else {
      if (current !== 'bypass') {
        context.writeLine('Bypass mode is already disabled.')
        return
      }
      context.setPermissionMode('default')
      context.writeLine('Bypass mode disabled. Permission mode reset to default.')
    }
  },
}
