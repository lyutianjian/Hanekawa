import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { PermissionDialogState } from '../types.js'

/**
 * Pure logic for the PermissionDialog component.
 *
 * These are exported and unit-tested in `test/permissionDialog.test.ts` so
 * the component itself can stay free of imperative testing infrastructure.
 */

export type PermissionAction = 'allow' | 'deny' | 'always'

export interface PermissionOption {
  readonly action: PermissionAction
  readonly label: string
  readonly hotkey: 'y' | 'n' | 'a'
}

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { action: 'allow', label: 'Allow', hotkey: 'y' },
  { action: 'deny', label: 'Deny', hotkey: 'n' },
  { action: 'always', label: 'Always allow', hotkey: 'a' },
] as const

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Compute the next selected index given a direction. Bounded (no wrap-around)
 * to match the behaviour of `RestoreMode`. Out-of-range `current` values are
 * first clamped into `[0, total - 1]` before the move is applied.
 */
export function nextPermissionIndex(
  current: number,
  direction: 'up' | 'down',
  total: number,
): number {
  if (total <= 0) return 0
  const safe = clamp(current, 0, total - 1)
  if (direction === 'up') return Math.max(0, safe - 1)
  return Math.min(total - 1, safe + 1)
}

/**
 * Resolve a selected index to its action. Out-of-range indices are clamped
 * to the nearest valid option so the function is total.
 */
export function resolvePermissionAction(index: number): PermissionAction {
  const safe = clamp(index, 0, PERMISSION_OPTIONS.length - 1)
  return PERMISSION_OPTIONS[safe]!.action
}

interface PermissionDialogProps {
  permState: PermissionDialogState
  respond: (approved: boolean) => void
}

export function PermissionDialog({ permState, respond }: PermissionDialogProps) {
  const { request } = permState
  const [selectedIndex, setSelectedIndex] = useState(0)

  const performAction = (action: PermissionAction) => {
    if (action === 'allow') {
      respond(true)
    } else if (action === 'deny') {
      respond(false)
    } else {
      // 'always'
      request?.onAlwaysAllow?.()
      respond(true)
    }
  }

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => nextPermissionIndex(i, 'up', PERMISSION_OPTIONS.length))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => nextPermissionIndex(i, 'down', PERMISSION_OPTIONS.length))
      return
    }
    if (key.return) {
      performAction(resolvePermissionAction(selectedIndex))
      return
    }
    if (key.escape) {
      performAction('deny')
      return
    }
    // Letter-key fallbacks (case-insensitive). These bypass the highlighted
    // selection and act on their own action directly. They keep working for
    // muscle-memory users; input leakage to the InputBox is prevented by
    // `useKeyboardShortcuts` honouring `isPermissionVisible`.
    const lower = input.toLowerCase()
    if (lower === 'y') {
      performAction('allow')
    } else if (lower === 'n') {
      performAction('deny')
    } else if (lower === 'a') {
      performAction('always')
    }
  })

  if (!request) return null

  const inputSummary =
    typeof request.input === 'string'
      ? request.input.slice(0, 200)
      : JSON.stringify(request.input, null, 2)?.slice(0, 200) ?? ''

  // Per-hotkey colour to preserve the existing visual language (green/red/brand).
  const hotkeyColor = (action: PermissionAction): string => {
    if (action === 'allow') return theme.success
    if (action === 'deny') return theme.error
    return theme.brand
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      padding={1}
      marginY={1}
    >
      <Text bold color={theme.warning}>
        Permission Required
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color={theme.toolName} bold>
            {request.tool.name}
          </Text>
          <Text color={theme.dimText}> ({request.tool.riskLevel})</Text>
        </Text>
      </Box>
      <Text color={theme.assistantText}>{request.reason}</Text>
      {request.denialStreak > 1 ? (
        <Box marginTop={1}>
          <Text color={theme.error} bold>
            ⚠ Model has hit this block {request.denialStreak}× in a row — it may be looping.
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.dimText}>Input: {inputSummary}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex
          const prefix = isSelected ? '▸ ' : '  '
          const upperHotkey = option.hotkey.toUpperCase()
          return (
            <Box key={option.action}>
              <Text color={isSelected ? theme.brand : undefined} bold={isSelected}>
                {prefix}[
                <Text color={hotkeyColor(option.action)} bold>
                  {upperHotkey}
                </Text>
                ] {option.label}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dimText}>
          [↑/↓] Navigate  [Enter] Select  [Esc] Cancel  [y/n/a] Quick
        </Text>
      </Box>
    </Box>
  )
}
