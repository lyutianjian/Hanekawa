import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { theme } from '../theme.js'

export interface EnterPlanModeDialogProps {
  onResolve(approved: boolean): void
}

interface EntryOption {
  readonly value: 'yes' | 'no'
  readonly label: string
  readonly hotkey: '1' | '2'
}

const OPTIONS: readonly EntryOption[] = [
  { value: 'yes', label: 'Yes, enter plan mode', hotkey: '1' },
  { value: 'no', label: 'No, start implementing now', hotkey: '2' },
] as const

/**
 * Dedicated entry confirmation for model-driven `EnterPlanMode` calls.
 * Aligned with Claude Code's `EnterPlanModePermissionRequest`:
 *   - title "Enter plan mode?", plan-mode (warning) color
 *   - body explaining what the model will do in plan mode
 *   - explicit "no code changes will be made until you approve the plan"
 *     reassurance
 *   - two-option Select + Esc to cancel
 *
 * User-initiated plan-mode entries (`/plan` and Shift+Tab) skip this
 * dialog entirely and flip the gate directly �?they are explicit user
 * intent and don't need confirmation. This dialog appears only when the
 * model autonomously calls the `EnterPlanMode` tool.
 */
export function EnterPlanModeDialog({ onResolve }: EnterPlanModeDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(OPTIONS.length - 1, i + 1))
      return
    }

    if (input === '1' || input === '2') {
      const target = OPTIONS.find((o) => o.hotkey === input)
      if (target) onResolve(target.value === 'yes')
      return
    }

    if (key.return) {
      const option = OPTIONS[selectedIndex]
      if (option) onResolve(option.value === 'yes')
      return
    }

    if (key.escape) {
      onResolve(false)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} padding={1} marginY={1}>
      <Box>
        <Text bold color={theme.warning}>Enter plan mode?</Text>
      </Box>

      <Box marginTop={1}>
        <Text>The agent wants to enter plan mode to explore and design an implementation approach.</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.dimText}>In plan mode, the agent will:</Text>
        <Text color={theme.dimText}> · Explore the codebase thoroughly</Text>
        <Text color={theme.dimText}> · Identify existing patterns</Text>
        <Text color={theme.dimText}> · Design an implementation strategy</Text>
        <Text color={theme.dimText}> · Present a plan for your approval</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dimText}>No code changes will be made until you approve the plan.</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex
          return (
            <Box key={option.value}>
              <Text color={isSelected ? theme.brand : undefined} bold={isSelected}>
                {isSelected ? '> ' : '  '}[
                <Text color={theme.toolName} bold>{option.hotkey}</Text>
                ] {option.label}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text color={theme.dimText}>
            [Up/Down] Move  [1-2] Quick  [Enter] Select  [Esc] Decline
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
