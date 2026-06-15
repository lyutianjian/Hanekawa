import React, { useMemo, useCallback, memo } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import type { TUIDisplayItem } from '../types.js'
import { estimateDisplayItemRows, selectScrollableViewportEntries } from '../layout.js'
import { DisplayItem } from './MessageList.js'
import { theme } from '../theme.js'

const HEADER_ROWS = 1
const FOOTER_ROWS = 1
const CHROME_ROWS = HEADER_ROWS + FOOTER_ROWS
const MOUSE_WHEEL_SCROLL_ROWS = 3
const SGR_MOUSE_INPUT_PATTERN = /^\x1B?\[<(\d+);\d+;\d+([mM])$/

interface TranscriptViewProps {
  items: TUIDisplayItem[]
  scrollOffsetRows: number
  onScrollOffsetRowsChange: (update: (previous: number) => number) => void
  onExit: () => void
}

export const TranscriptView = memo(function TranscriptView({
  items,
  scrollOffsetRows,
  onScrollOffsetRowsChange,
  onExit,
}: TranscriptViewProps) {
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 24
  const columns = stdout?.columns ?? 80
  const viewportHeight = Math.max(1, rows - CHROME_ROWS)

  const entries = useMemo(
    () => items.map((item) => ({
      item,
      estimatedRows: estimateDisplayItemRows(item, columns, true),
    })),
    [items, columns],
  )

  const viewport = useMemo(
    () => selectScrollableViewportEntries(entries, viewportHeight, scrollOffsetRows),
    [entries, viewportHeight, scrollOffsetRows],
  )

  const scrollDown = useCallback((rows: number) => {
    onScrollOffsetRowsChange((previous) => Math.max(0, previous - rows))
  }, [onScrollOffsetRowsChange])

  const scrollUp = useCallback((rows: number) => {
    onScrollOffsetRowsChange((previous) => Math.min(viewport.maxScrollOffsetRows, previous + rows))
  }, [onScrollOffsetRowsChange, viewport.maxScrollOffsetRows])

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'o')) {
      onExit()
      return
    }
    const wheelDirection = getSgrMouseWheelDirection(input)
    if (wheelDirection === 'up') {
      scrollUp(MOUSE_WHEEL_SCROLL_ROWS)
      return
    }
    if (wheelDirection === 'down') {
      scrollDown(MOUSE_WHEEL_SCROLL_ROWS)
      return
    }
    if (key.downArrow) {
      scrollDown(1)
      return
    }
    if (key.upArrow) {
      scrollUp(1)
      return
    }
  })

  return (
    <Box flexDirection="column" height={rows} width="100%">
      <Box width="100%">
        <Text color={theme.dimText} dimColor>
          {'-- Transcript '}
          <Text color={theme.subtleText}>(ctrl+o to exit)</Text>
          {' --'}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={0}>
        {viewport.entries.map(({ item }) => (
          <DisplayItem
            key={item.id}
            item={item}
            expanded
            isTranscriptMode
            animationsEnabled={false}
          />
        ))}
      </Box>

      <Box width="100%">
        <Text color={theme.dimText} dimColor>
          {'ctrl+o: exit'}
        </Text>
      </Box>
    </Box>
  )
})

function getSgrMouseWheelDirection(input: string): 'up' | 'down' | null {
  const match = SGR_MOUSE_INPUT_PATTERN.exec(input)
  if (!match) return null
  if (match[2] !== 'M') return null

  const buttonCode = Number(match[1])
  if (!Number.isInteger(buttonCode) || (buttonCode & 64) === 0) return null

  const wheelButton = buttonCode & 3
  if (wheelButton === 0) return 'up'
  if (wheelButton === 1) return 'down'
  return null
}
