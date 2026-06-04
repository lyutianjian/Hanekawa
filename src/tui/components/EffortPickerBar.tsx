import { useState } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import { theme } from '../theme.js'
import {
  EFFORT_RANK,
  VALID_EFFORT_LEVELS,
  effortDescription,
  type EffortLevel,
} from '../../config/effort.js'

export interface EffortPickerBarProps {
  currentLevel: EffortLevel
  maxEffort: EffortLevel | undefined
  onResolve: (result: { action: 'set'; level: EffortLevel } | { action: 'cancel' }) => void
}

const PILL_GAP = 4
const PILL_PAD = 1

function isLevelDisabled(level: EffortLevel, maxEffort: EffortLevel | undefined): boolean {
  if (!maxEffort) return false
  return EFFORT_RANK[level] > EFFORT_RANK[maxEffort]
}

function nextEnabledIndex(maxEffort: EffortLevel | undefined, current: number, direction: 1 | -1): number {
  const len = VALID_EFFORT_LEVELS.length
  let index = current
  for (let step = 0; step < len; step++) {
    const candidate = index + direction
    if (candidate < 0 || candidate >= len) return current
    const level = VALID_EFFORT_LEVELS[candidate]
    if (!isLevelDisabled(level, maxEffort)) return candidate
    index = candidate
  }
  return current
}

function initialIndex(currentLevel: EffortLevel, maxEffort: EffortLevel | undefined): number {
  const idx = VALID_EFFORT_LEVELS.indexOf(currentLevel)
  if (idx >= 0 && !isLevelDisabled(currentLevel, maxEffort)) return idx
  for (let i = VALID_EFFORT_LEVELS.length - 1; i >= 0; i--) {
    if (!isLevelDisabled(VALID_EFFORT_LEVELS[i]!, maxEffort)) return i
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

export function EffortPickerBar({ currentLevel, maxEffort, onResolve }: EffortPickerBarProps) {
  const { stdout } = useStdout()
  const terminalWidth = stdout?.columns || 80
  const [selectedIndex, setSelectedIndex] = useState<number>(() => initialIndex(currentLevel, maxEffort))

  useInput((input, key) => {
    if (key.escape) {
      onResolve({ action: 'cancel' })
      return
    }

    if (key.leftArrow) {
      setSelectedIndex((i) => nextEnabledIndex(maxEffort, i, -1))
      return
    }

    if (key.rightArrow) {
      setSelectedIndex((i) => nextEnabledIndex(maxEffort, i, 1))
      return
    }

    if (input >= '1' && input <= '5') {
      const target = Number(input) - 1
      const level = VALID_EFFORT_LEVELS[target]
      if (level && !isLevelDisabled(level, maxEffort)) {
        setSelectedIndex(target)
      }
      return
    }

    if (key.return) {
      const level = VALID_EFFORT_LEVELS[selectedIndex]
      if (!level || isLevelDisabled(level, maxEffort)) return
      onResolve({ action: 'set', level })
    }
  })

  const selectedLevel = VALID_EFFORT_LEVELS[selectedIndex]
  const description = selectedLevel ? effortDescription(selectedLevel) : ''
  const arrowColumn = indicatorColumn(selectedIndex)
  const centerOffset = Math.max(0, Math.floor((terminalWidth - rowWidth()) / 2))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.border}>{'─'.repeat(terminalWidth)}</Text>
      </Box>

      <Box flexDirection="row" marginLeft={centerOffset} marginTop={1}>
        {VALID_EFFORT_LEVELS.map((level, index) => {
          const selected = index === selectedIndex
          const disabled = isLevelDisabled(level, maxEffort)
          const color = disabled ? theme.dimText : selected ? theme.brand : theme.assistantText
          const pad = ' '.repeat(PILL_PAD)
          const gap = index < VALID_EFFORT_LEVELS.length - 1 ? ' '.repeat(PILL_GAP) : ''
          return (
            <Text key={level} color={color} bold={!disabled && selected}>
              {pad}
              {level.toUpperCase()}
              {pad}
              {gap}
            </Text>
          )
        })}
      </Box>

      <Box marginLeft={centerOffset + arrowColumn}>
        <Text color={theme.brand}>▲</Text>
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Text color={theme.assistantText}>{description}</Text>
      </Box>

      <Box justifyContent="center">
        <Text color={theme.dimText}>
          ←/→ to adjust · 1-5 to jump · Enter to confirm · Esc to cancel
        </Text>
      </Box>
    </Box>
  )
}
