import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { theme } from '../theme.js'
import { CommandListItem, CommandPane } from './CommandUI.js'

export type ModelPickerAction = 'set-default' | 'session-only'

// Declared with the builder, in `src/runtime/`: the options are resolved
// against ConfigService, which never crosses to a viewer, and they ride to one
// on `WireModelsResult`. Re-exported so this file stays the single import for
// anything rendering the dialog.
import type { ModelPickerOption } from '../../runtime/modelPicker.js'
export type { ModelPickerOption }

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
    <CommandPane
      title="Select model"
      subtitle="Choose the model for this session or make it the default."
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: 'Enter', action: 'set default' },
        { key: 'S', action: 'use for this session' },
        { key: 'Esc', action: 'close' },
      ]}
    >
      <Box flexDirection="column">
        {options.map((option, index) => {
          const selected = index === selectedIndex
          const disabled = option.disabledReason !== undefined
          return (
            <CommandListItem
              key={option.key}
              focused={selected}
              selected={option.isCurrent}
              disabled={disabled}
              description={disabled ? option.disabledReason : `${option.modelKey} · ${option.providerName}: ${option.modelId}`}
            >
              {index + 1}. {option.label}
              {option.isDefault ? <Text color={theme.success}>  default</Text> : null}
              {option.isCurrent ? <Text color={theme.toolName}>  current</Text> : null}
            </CommandListItem>
          )
        })}
      </Box>
    </CommandPane>
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
