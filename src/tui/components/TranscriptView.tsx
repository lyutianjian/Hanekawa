import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import type { SessionStore } from '../../sessions/service.js'
import type { TUIDisplayItem } from '../types.js'
import { recordsToDisplayItems } from '../transcript.js'
import { estimateDisplayItemRows, selectScrollableViewportEntries } from '../layout.js'
import { DisplayItem } from './MessageList.js'
import { theme } from '../theme.js'

const HEADER_ROWS = 1
const FOOTER_ROWS = 1
const CHROME_ROWS = HEADER_ROWS + FOOTER_ROWS

interface TranscriptViewProps {
  store: SessionStore
  sessionId: string
  onExit: () => void
}

export function TranscriptView({ store, sessionId, onExit }: TranscriptViewProps) {
  const [items, setItems] = useState<TUIDisplayItem[]>([])
  const [scrollOffsetRows, setScrollOffsetRows] = useState(0)
  const [loading, setLoading] = useState(true)
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 24
  const columns = stdout?.columns ?? 80

  // Load records on mount
  useEffect(() => {
    let cancelled = false
    void store.loadRecords(sessionId).then((records) => {
      if (cancelled) return
      const displayItems = recordsToDisplayItems(records)
      setItems(displayItems)
      setLoading(false)
      // Start at the bottom (latest messages)
      setScrollOffsetRows(0)
    })
    return () => { cancelled = true }
  }, [store, sessionId])

  const viewportHeight = Math.max(1, rows - CHROME_ROWS)

  // Build entries with estimated row counts (all expanded in transcript mode)
  const entries = useMemo(
    () => items.map((item) => ({
      item,
      estimatedRows: estimateDisplayItemRows(item, columns, /* expanded */ true),
    })),
    [items, columns],
  )

  const viewport = useMemo(
    () => selectScrollableViewportEntries(entries, viewportHeight, scrollOffsetRows),
    [entries, viewportHeight, scrollOffsetRows],
  )

  const scrollDown = useCallback((rows: number) => {
    setScrollOffsetRows((prev) => Math.max(0, prev - rows))
  }, [])

  const scrollUp = useCallback((rows: number) => {
    setScrollOffsetRows((prev) => Math.min(viewport.maxScrollOffsetRows, prev + rows))
  }, [viewport.maxScrollOffsetRows])

  // Keyboard navigation
  useInput((input, key) => {
    // Exit
    if (key.escape || (key.ctrl && input === 'o')) {
      onExit()
      return
    }
    // Scroll down (show newer content)
    if (input === 'j' || key.downArrow) {
      scrollDown(1)
      return
    }
    // Scroll up (show older content)
    if (input === 'k' || key.upArrow) {
      scrollUp(1)
      return
    }
    // Go to top (oldest)
    if (input === 'g') {
      setScrollOffsetRows(viewport.maxScrollOffsetRows)
      return
    }
    // Go to bottom (newest)
    if (input === 'G') {
      setScrollOffsetRows(0)
      return
    }
    // Page down
    if (key.pageDown || input === ' ') {
      scrollDown(viewportHeight)
      return
    }
    // Page up
    if (key.pageUp || input === 'b') {
      scrollUp(viewportHeight)
      return
    }
  })

  if (loading) {
    return (
      <Box flexDirection="column" height={rows} justifyContent="center" alignItems="center">
        <Text color={theme.dimText}>Loading transcript...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height={rows} width="100%">
      {/* Header */}
      <Box width="100%">
        <Text color={theme.dimText} dimColor>
          {'── Transcript '}
          <Text color={theme.subtleText}>(ctrl+o to exit)</Text>
          {' ──'}
        </Text>
      </Box>

      {/* Viewport */}
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

      {/* Footer */}
      <Box width="100%">
        <Text color={theme.dimText} dimColor>
          {'j/k: scroll  g/G: top/bottom  ctrl+o: exit'}
        </Text>
      </Box>
    </Box>
  )
}
