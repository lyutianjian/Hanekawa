import { useState } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import { theme } from '../theme.js'
import {
  VALID_EFFORT_LEVELS,
  effortDescription,
  isEffortSupported,
  type EffortLevel,
} from '../../config/effort.js'
import { CommandListItem, CommandPane } from './CommandUI.js'

export interface EffortPickerBarProps {
  currentLevel: EffortLevel
  /** The levels the model accepts; undefined means all of them. */
  supportedEfforts: readonly EffortLevel[] | undefined
  onResolve: (result: { action: 'set'; level: EffortLevel } | { action: 'cancel' }) => void
}

const PILL_GAP = 4
const PILL_PAD = 1

function isLevelDisabled(level: EffortLevel, supportedEfforts: readonly EffortLevel[] | undefined): boolean {
  return !isEffortSupported(level, supportedEfforts)
}

function nextEnabledIndex(
  supportedEfforts: readonly EffortLevel[] | undefined,
  current: number,
  direction: 1 | -1,
): number {
  const len = VALID_EFFORT_LEVELS.length
  let index = current
  for (let step = 0; step < len; step++) {
    const candidate = index + direction
    if (candidate < 0 || candidate >= len) return current
    const level = VALID_EFFORT_LEVELS[candidate]
    if (!isLevelDisabled(level, supportedEfforts)) return candidate
    index = candidate
  }
  return current
}

function initialIndex(
  currentLevel: EffortLevel,
  supportedEfforts: readonly EffortLevel[] | undefined,
): number {
  const idx = VALID_EFFORT_LEVELS.indexOf(currentLevel)
  if (idx >= 0 && !isLevelDisabled(currentLevel, supportedEfforts)) return idx
  for (let i = VALID_EFFORT_LEVELS.length - 1; i >= 0; i--) {
    if (!isLevelDisabled(VALID_EFFORT_LEVELS[i]!, supportedEfforts)) return i
  }
  return 0
}

function pillDisplayWidth(level: EffortLevel): number {
  return level.length + PILL_PAD * 2
}

function rowWidth(): number {
  let width = 0
  for (let i = 0; i < VALID_EFFORT_LEVELS.length; i++) {
    width += pillDisplayWidth(VALID_EFFORT_LEVELS[i]!)
    if (i < VALID_EFFORT_LEVELS.length - 1) width += PILL_GAP
  }
  return width
}

function indicatorColumn(selectedIndex: number): number {
  let column = 0
  for (let i = 0; i < selectedIndex; i++) {
    column += pillDisplayWidth(VALID_EFFORT_LEVELS[i]!) + PILL_GAP
  }
  column += PILL_PAD + Math.floor(VALID_EFFORT_LEVELS[selectedIndex]!.length / 2)
  return column
}

export function EffortPickerBar({ currentLevel, supportedEfforts, onResolve }: EffortPickerBarProps) {
  const { stdout } = useStdout()
  const terminalWidth = stdout?.columns || 80
  const [selectedIndex, setSelectedIndex] = useState<number>(() => initialIndex(currentLevel, supportedEfforts))

  useInput((input, key) => {
    if (key.escape) {
      onResolve({ action: 'cancel' })
      return
    }

    if (key.leftArrow || key.upArrow) {
      setSelectedIndex((i) => nextEnabledIndex(supportedEfforts, i, -1))
      return
    }

    if (key.rightArrow || key.downArrow) {
      setSelectedIndex((i) => nextEnabledIndex(supportedEfforts, i, 1))
      return
    }

    if (input >= '1' && input <= '5') {
      const target = Number(input) - 1
      const level = VALID_EFFORT_LEVELS[target]
      if (level && !isLevelDisabled(level, supportedEfforts)) {
        setSelectedIndex(target)
      }
      return
    }

    if (key.return) {
      const level = VALID_EFFORT_LEVELS[selectedIndex]
      if (!level || isLevelDisabled(level, supportedEfforts)) return
      onResolve({ action: 'set', level })
    }
  })

  const selectedLevel = VALID_EFFORT_LEVELS[selectedIndex]
  const description = selectedLevel ? effortDescription(selectedLevel) : ''
  const arrowColumn = indicatorColumn(selectedIndex)
  const centerOffset = Math.max(0, Math.floor((terminalWidth - rowWidth()) / 2))
  const compact = terminalWidth < rowWidth() + 4

  return (
    <CommandPane
      title="Effort"
      subtitle="Adjust how much reasoning the model uses."
      hints={[
        { key: compact ? '↑/↓' : '←/→', action: 'navigate' },
        { key: '1–5', action: 'jump' },
        { key: 'Enter', action: 'confirm' },
        { key: 'Esc', action: 'close' },
      ]}
    >
      {compact ? (
        <Box flexDirection="column">
          {VALID_EFFORT_LEVELS.map((level, index) => (
            <CommandListItem
              key={level}
              focused={index === selectedIndex}
              selected={level === currentLevel}
              disabled={isLevelDisabled(level, supportedEfforts)}
              description={index === selectedIndex ? effortDescription(level) : undefined}
            >
              {index + 1}. {level.toUpperCase()}
            </CommandListItem>
          ))}
        </Box>
      ) : (
        <>
          <Box flexDirection="row" marginLeft={centerOffset}>
            {VALID_EFFORT_LEVELS.map((level, index) => {
              const selected = index === selectedIndex
              const disabled = isLevelDisabled(level, supportedEfforts)
              const color = disabled ? theme.dimText : selected ? theme.brand : theme.assistantText
              const pad = ' '.repeat(PILL_PAD)
              const gap = index < VALID_EFFORT_LEVELS.length - 1 ? ' '.repeat(PILL_GAP) : ''
              return (
                <Text key={level} color={color} bold={!disabled && selected}>
                  {pad}{level.toUpperCase()}{pad}{gap}
                </Text>
              )
            })}
          </Box>
          <Box marginLeft={centerOffset + arrowColumn}><Text color={theme.brand}>▲</Text></Box>
          <Box justifyContent="center" marginTop={1}><Text>{description}</Text></Box>
        </>
      )}
    </CommandPane>
  )
}
