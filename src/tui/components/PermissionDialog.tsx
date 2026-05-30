import { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { PermissionDialogRequest, PermissionDialogState } from '../types.js'
import type { PermissionRequest } from '../../harness/permissions.js'

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
  respond: (id: string, approved: boolean) => void
  setActiveRequest: (id: string) => void
}

export function PermissionDialog({ permState, respond, setActiveRequest }: PermissionDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Reset selectedIndex when switching between permission requests to avoid
  // "Always allow" carrying over from one request to the next.
  useEffect(() => { setSelectedIndex(0) }, [permState.activeRequestId])
  const activeIndex = Math.max(0, permState.requests.findIndex((entry) => entry.id === permState.activeRequestId))
  const activeEntry = permState.requests[activeIndex] ?? permState.requests[0]
  const request = activeEntry?.request

  const performAction = (action: PermissionAction) => {
    if (!activeEntry) return
    if (action === 'allow') {
      respond(activeEntry.id, true)
    } else if (action === 'deny') {
      respond(activeEntry.id, false)
    } else {
      request?.onAlwaysAllow?.()
      respond(activeEntry.id, true)
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
    if (key.leftArrow || key.rightArrow || key.tab) {
      const direction = key.leftArrow ? 'up' : 'down'
      const nextIndex = nextPermissionIndex(activeIndex, direction, permState.requests.length)
      const nextEntry = permState.requests[nextIndex]
      if (nextEntry) setActiveRequest(nextEntry.id)
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
    const lower = input.toLowerCase()
    if (lower === 'y') {
      performAction('allow')
    } else if (lower === 'n') {
      performAction('deny')
    } else if (lower === 'a') {
      performAction('always')
    }
  })

  if (!request || !activeEntry) return null

  const inputSummary =
    typeof request.input === 'string'
      ? request.input.slice(0, 200)
      : JSON.stringify(request.input, null, 2)?.slice(0, 200) ?? ''

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
        Permission Required{permState.requests.length > 1 ? ` (${activeIndex + 1}/${permState.requests.length})` : ''}
      </Text>
      {permState.requests.length > 1 ? (
        <Box flexDirection="column" marginTop={1}>
          {permState.requests.map((entry, index) => (
            <Text key={entry.id} color={entry.id === activeEntry.id ? theme.brand : theme.dimText}>
              {entry.id === activeEntry.id ? '> ' : '  '}
              {index + 1}. {formatPermissionRequestLabel(entry)}
            </Text>
          ))}
        </Box>
      ) : null}
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
            Model has hit this block {request.denialStreak}x in a row; it may be looping.
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.dimText}>Input: {inputSummary}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex
          const prefix = isSelected ? '> ' : '  '
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
          [Up/Down] Options  [Left/Right/Tab] Requests  [Enter] Select  [Esc] Cancel  [y/n/a] Quick
        </Text>
      </Box>
    </Box>
  )
}

function formatPermissionRequestLabel(entry: PermissionDialogRequest): string {
  const request = entry.request
  if (request.tool.name !== 'Agent' || !request.input || typeof request.input !== 'object') {
    return request.tool.name
  }
  const subagentType = (request.input as Record<string, unknown>).subagent_type
  return typeof subagentType === 'string' ? `Agent:${subagentType}` : 'Agent'
}
