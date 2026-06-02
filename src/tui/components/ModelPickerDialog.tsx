import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { theme } from '../theme.js'
import type { Tier } from '../../config/routing.js'

export type ModelTierChoice = Tier
export type ModelPickerAction = 'set-default' | 'session-only'

export interface ModelPickerOption {
  tier: ModelTierChoice
  label: string
  modelKey?: string
  providerName?: string
  modelId?: string
  disabledReason?: string
  isCurrent: boolean
  isDefault: boolean
}

export interface ModelPickerDecision {
  action: ModelPickerAction
  option: ModelPickerOption
}

export interface ModelPickerDialogProps {
  options: ModelPickerOption[]
  onResolve(decision: ModelPickerDecision | { action: 'cancel' }): void
}

export function ModelPickerDialog({ options, onResolve }: ModelPickerDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(() => firstEnabledIndex(options))

  useEffect(() => {
    const next = firstEnabledIndex(options)
    setSelectedIndex((current) => {
      if (options[current] && !options[current]?.disabledReason) return current
      return next
    })
  }, [options])

  const resolveSelected = (action: ModelPickerAction) => {
    const option = options[selectedIndex]
    if (!option || option.disabledReason) return
    onResolve({ action, option })
  }

  useInput((input, key) => {
    if (key.escape) {
      onResolve({ action: 'cancel' })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((index) => previousEnabledIndex(options, index))
      return
    }

    if (key.downArrow) {
      setSelectedIndex((index) => nextEnabledIndex(options, index))
      return
    }

    if (input === '1' || input === '2' || input === '3') {
      const target = Number(input) - 1
      if (options[target] && !options[target]?.disabledReason) {
        setSelectedIndex(target)
      }
      return
    }

    if (input === 's' || input === 'S') {
      resolveSelected('session-only')
      return
    }

    if (key.return) {
      resolveSelected('set-default')
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} paddingY={1} marginTop={1}>
      <Text bold color={theme.brand}>Select model</Text>
      <Text color={theme.dimText}>
        Switch between configured model tiers. Enter sets the default for new sessions; s uses this session only.
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const selected = index === selectedIndex
          const disabled = option.disabledReason !== undefined
          const color = disabled ? theme.dimText : selected ? theme.brand : theme.assistantText
          return (
            <Box key={option.tier} flexDirection="column">
              <Text color={color} bold={selected && !disabled}>
                {selected ? '> ' : '  '}
                {index + 1}. {option.label}
                {option.isDefault ? <Text color={theme.success}> default</Text> : null}
                {option.isCurrent ? <Text color={theme.toolName}> current</Text> : null}
              </Text>
              <Box paddingLeft={5}>
                <Text color={disabled ? theme.dimText : theme.dimText}>
                  {disabled
                    ? option.disabledReason
                    : `${option.modelKey} (${option.providerName}: ${option.modelId})`}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dimText}>Enter to set as default · s to use this session only · Esc to cancel</Text>
      </Box>
    </Box>
  )
}

function firstEnabledIndex(options: ModelPickerOption[]): number {
  const index = options.findIndex((option) => option.disabledReason === undefined)
  return index >= 0 ? index : 0
}

function nextEnabledIndex(options: ModelPickerOption[], current: number): number {
  if (options.length === 0) return 0
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (current + offset) % options.length
    if (!options[index]?.disabledReason) return index
  }
  return current
}

function previousEnabledIndex(options: ModelPickerOption[], current: number): number {
  if (options.length === 0) return 0
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (current - offset + options.length) % options.length
    if (!options[index]?.disabledReason) return index
  }
  return current
}
