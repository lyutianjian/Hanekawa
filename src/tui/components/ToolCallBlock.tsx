import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { getToolActivityDescription, getToolDisplay, shouldDisplayToolResult } from '../../tools/display.js'
import type { ToolResultDisplay } from '../../harness/types.js'
import { theme } from '../theme.js'
import type { TUIDisplayItem, ToolCallStatus } from '../types.js'

interface ToolCallBlockProps {
  item: Extract<TUIDisplayItem, { kind: 'tool_call' }>
  expanded?: boolean
}

const COLLAPSE_LINES = 3
const STATUS_DOT = '\u25cf'

export function ToolCallBlock({ item, expanded }: ToolCallBlockProps) {
  const statusDot = getStatusDot(item.status)
  const blinkOff = useBlink(item.status === 'running' || item.status === 'approved')
  const display = getToolDisplay(item.tool, item.input)
  const result = item.result

  return (
    <Box flexDirection="column" paddingLeft={2} marginY={0}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2} flexShrink={0}>
          <Text color={statusDot.color} dimColor={item.status === 'pending'}>
            {blinkOff ? ' ' : statusDot.char}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.toolName} bold wrap="truncate-end">
            {display.name}
          </Text>
        </Box>
        {display.summary && (
          <Box flexShrink={1} minWidth={0}>
            <Text color={theme.dimText}>{` (${display.summary})`}</Text>
          </Box>
        )}
      </Box>

      {item.status === 'denied' && (
        <Box paddingLeft={2}>
          <Text color={theme.error}>denied</Text>
        </Box>
      )}

      {item.status === 'error' && result && (
        <Box paddingLeft={2} flexDirection="column">
          {item.errorCode && (
            <Text color={theme.error} dimColor>
              error: {item.errorCode}
            </Text>
          )}
          <Text color={theme.error}>{result}</Text>
        </Box>
      )}

      {item.status === 'done' && result && shouldDisplayToolResult(item.tool, item.input, result) && (
        <OutputBlock result={result} display={item.resultDisplay} expanded={expanded} />
      )}
    </Box>
  )
}

export function formatToolCallRunningDescription(tool: string, input: unknown): string {
  return getToolActivityDescription(tool, input) ?? 'running...'
}

function OutputBlock({ result, display, expanded }: { result: string; display?: ToolResultDisplay; expanded?: boolean }) {
  if (display && !expanded) {
    const hasDetail = (display.detail ?? result).trim().length > 0
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text color={theme.dimText}>{'| '}</Text>
          <Text color={theme.dimText}>{display.summary}</Text>
          {hasDetail && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </Box>
    )
  }

  const lines = result.split('\n')
  const totalLines = lines.length

  if (totalLines === 0) return null

  if (display && expanded) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text color={theme.dimText}>{'| '}</Text>
          <Text color={theme.dimText}>{display.summary}</Text>
        </Box>
        <DetailLines lines={(display.detail ?? result).split('\n')} />
        <Box paddingLeft={3}>
          <Text color={theme.dimText} dimColor>
            (ctrl+o to collapse)
          </Text>
        </Box>
      </Box>
    )
  }

  if (expanded || totalLines <= COLLAPSE_LINES) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <DetailLines lines={lines} />
        {totalLines > COLLAPSE_LINES && (
          <Box paddingLeft={3}>
            <Text color={theme.dimText} dimColor>
              (ctrl+o to collapse)
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const visibleLines = lines.slice(0, COLLAPSE_LINES)
  const hiddenCount = totalLines - COLLAPSE_LINES

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <DetailLines lines={visibleLines} />
      <Box paddingLeft={3}>
        <Text color={theme.dimText} dimColor>
          ... +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'} (ctrl+o to expand)
        </Text>
      </Box>
    </Box>
  )
}

function DetailLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.dimText}>{'| '}</Text>
          <Text color={theme.dimText}>{line}</Text>
        </Box>
      ))}
    </>
  )
}

export function getStatusDot(status: ToolCallStatus): { char: string; color: string } {
  switch (status) {
    case 'pending':
      return { char: STATUS_DOT, color: theme.dimText }
    case 'running':
      return { char: STATUS_DOT, color: theme.toolName }
    case 'approved':
      return { char: STATUS_DOT, color: theme.warning }
    case 'denied':
      return { char: STATUS_DOT, color: theme.error }
    case 'done':
      return { char: STATUS_DOT, color: theme.success }
    case 'error':
      return { char: STATUS_DOT, color: theme.error }
  }
}

function useBlink(enabled: boolean): boolean {
  const [dim, setDim] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setDim(false)
      return
    }
    const timer = setInterval(() => setDim((current) => !current), 500)
    return () => clearInterval(timer)
  }, [enabled])
  return enabled && dim
}
