import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import type { TUIDisplayItem } from '../types.js'
import { getStatusDot, ToolCallBlock } from './ToolCallBlock.js'
import { ResponseBlock } from './ResponseBlock.js'
import { INDENT_TOOL, MIN_HINT_DISPLAY_MS } from '../constants/figures.js'
import { useBlink } from '../hooks/useBlink.js'
import { formatToolGroupResultSummary, formatToolGroupSummary } from '../utils/toolGroupSummary.js'

interface CollapsedToolGroupProps {
  item: Extract<TUIDisplayItem, { kind: 'tool_group' }>
  expanded?: boolean
  animationsEnabled?: boolean
  isTranscriptMode?: boolean
}

/**
 * Collapsed parallel-tool group display.
 *
 * Collapsed view (default):
 *   ● Read 5 files, searched 3 patterns (ctrl+o to expand)
 *     ⎿  src/foo.ts
 *
 * Expanded view (Ctrl+O):
 *   ● Read 5 files, searched 3 patterns (ctrl+o to collapse)
 *     ⎿  ● Read(src/foo.ts)
 *     ⎿    ⎿ Read 150 lines
 *     ⎿  ● Search(pattern: "bar")
 *     ⎿    ⎿ Found 3 matches across 1 files
 *
 * The hint line (`  ⎿  <summary of last tool>`) is held back for
 * MIN_HINT_DISPLAY_MS so fast-completing batches don't flicker a line.
 */
export function CollapsedToolGroup({ item, expanded, animationsEnabled = true, isTranscriptMode = false }: CollapsedToolGroupProps) {
  const { toolCalls } = item
  const summary = formatToolGroupSummary(toolCalls)
  const allDone = toolCalls.every((call) => call.status === 'done' || call.status === 'error' || call.status === 'denied')
  const anyError = toolCalls.some((call) => call.status === 'error' || call.status === 'denied')
  // Status dot mirrors the "worst" child: green when all done, red on error,
  // blinking sky-blue while any call is still running.
  const dotStatus = anyError ? 'error' : allDone ? 'done' : 'running'
  const statusDot = getStatusDot(dotStatus)
  const blinkOff = useBlink(animationsEnabled && dotStatus === 'running')

  // Delay the aggregate result so fast-completing batches do not flicker.
  const [hintVisible, setHintVisible] = useState(false)
  useEffect(() => {
    if (expanded) {
      setHintVisible(true)
      return
    }
    setHintVisible(false)
    const timer = setTimeout(() => setHintVisible(true), MIN_HINT_DISPLAY_MS)
    return () => clearTimeout(timer)
  }, [expanded, toolCalls.length])

  const hintText = formatToolGroupResultSummary(toolCalls)

  if (expanded) {
    return (
      <Box flexDirection="column" paddingLeft={INDENT_TOOL} marginBottom={1}>
        <Box flexDirection="row" flexWrap="nowrap">
          <Box minWidth={2} flexShrink={0}>
            <Text color={statusDot.color}>
              {blinkOff ? ' ' : statusDot.char}
            </Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text color={theme.dimText}>{summary}</Text>
            {!isTranscriptMode && <Text color={theme.dimText} dimColor> (ctrl+o to collapse)</Text>}
          </Box>
        </Box>
        {toolCalls.map((call) => (
          <Box key={call.toolUseId} flexDirection="row" flexWrap="nowrap">
            <Box flexShrink={0}>
              <Text color={theme.subtleText}>{'  \u23bf  '}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <ToolCallBlock item={call} expanded animationsEnabled={animationsEnabled} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={INDENT_TOOL} marginBottom={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2} flexShrink={0}>
          <Text color={statusDot.color}>
            {blinkOff ? ' ' : statusDot.char}
          </Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={theme.dimText}>{summary}</Text>
          {!isTranscriptMode && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </Box>
      {hintVisible && hintText && (
        <ResponseBlock>
          <Text color={theme.dimText}>{hintText}</Text>
        </ResponseBlock>
      )}
    </Box>
  )
}
