import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { getToolActivityDescription, getToolDisplay, shouldDisplayToolResult } from '../../tools/display.js'
import type { ToolResultDisplay } from '../../harness/types.js'
import { theme } from '../theme.js'
import type { TUIDisplayItem, ToolCallStatus } from '../types.js'
import { ResponseBlock } from './ResponseBlock.js'
import { AnsiText, hasAnsi, stripAnsi } from '../ansi.js'

interface ToolCallBlockProps {
  item: Extract<TUIDisplayItem, { kind: 'tool_call' }>
  expanded?: boolean
  animationsEnabled?: boolean
}

const COLLAPSE_LINES = 3
const STATUS_DOT = '\u25cf'

export function ToolCallBlock({ item, expanded, animationsEnabled = true }: ToolCallBlockProps) {
  const statusDot = getStatusDot(item.status)
  const runningOrApproved = item.status === 'running' || item.status === 'approved'
  const blinkOff = useBlink(animationsEnabled && runningOrApproved)
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
        <ResponseBlock>
          <Text color={theme.error}>denied</Text>
        </ResponseBlock>
      )}

      {item.status === 'error' && result && (
        <ResponseBlock>
          <Box flexDirection="column">
            {item.errorCode && (
              <Text color={theme.error} dimColor>
                error: {item.errorCode}
              </Text>
            )}
            {hasAnsi(result) ? (
              <AnsiText>{result}</AnsiText>
            ) : (
              <Text color={theme.error}>{result}</Text>
            )}
          </Box>
        </ResponseBlock>
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
  if (display?.taskSnapshot && !expanded) {
    const hasDetail = (display.detail ?? result).trim().length > 0
    return (
      <ResponseBlock>
        <Box flexWrap="wrap">
          <Text color={theme.dimText}>{display.summary}</Text>
          {hasDetail && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </ResponseBlock>
    )
  }

  if (display && !expanded) {
    const hasDetail = (display.detail ?? result).trim().length > 0
    return (
      <ResponseBlock>
        <Box flexWrap="wrap">
          <Text color={theme.dimText}>{display.summary}</Text>
          {hasDetail && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </ResponseBlock>
    )
  }

  const lines = result.split('\n')
  const totalLines = lines.length

  if (totalLines === 0) return null

  if (display && expanded) {
    return (
      <ResponseBlock>
        <Box flexDirection="column">
          <Box>
            <Text color={theme.dimText}>{display.summary}</Text>
          </Box>
          <DetailLines lines={(display.detail ?? result).split('\n')} />
          <Box>
            <Text color={theme.dimText} dimColor>
              (ctrl+o to collapse)
            </Text>
          </Box>
        </Box>
      </ResponseBlock>
    )
  }

  if (expanded || totalLines <= COLLAPSE_LINES) {
    return (
      <ResponseBlock>
        <Box flexDirection="column">
          <DetailLines lines={lines} />
          {totalLines > COLLAPSE_LINES && (
            <Box>
              <Text color={theme.dimText} dimColor>
                (ctrl+o to collapse)
              </Text>
            </Box>
          )}
        </Box>
      </ResponseBlock>
    )
  }

  const visibleLines = lines.slice(0, COLLAPSE_LINES)
  const hiddenCount = totalLines - COLLAPSE_LINES

  return (
    <ResponseBlock>
      <Box flexDirection="column">
        <DetailLines lines={visibleLines} />
        <Box>
          <Text color={theme.dimText} dimColor>
            ... +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'} (ctrl+o to expand)
          </Text>
        </Box>
      </Box>
    </ResponseBlock>
  )
}

function DetailLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Box key={i}>
          {hasAnsi(line) ? (
            <Text color={theme.dimText}>
              <AnsiText>{line}</AnsiText>
            </Text>
          ) : (
            <Text color={theme.dimText}>{line}</Text>
          )}
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
