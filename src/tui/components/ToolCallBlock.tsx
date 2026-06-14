import { Box, Text } from 'ink'
import { getToolActivityDescription, getToolDisplay, getToolResultSummary, shouldDisplayToolResult } from '../../tools/display.js'
import type { ToolResultDisplay } from '../../harness/types.js'
import { theme } from '../theme.js'
import type { TUIDisplayItem, ToolCallStatus } from '../types.js'
import { ResponseBlock } from './ResponseBlock.js'
import { AnsiText, hasAnsi } from '../ansi.js'
import { COLLAPSE_LINES, STATUS_DOT } from '../constants/figures.js'
import { useBlink } from '../hooks/useBlink.js'

interface ToolCallBlockProps {
  item: Extract<TUIDisplayItem, { kind: 'tool_call' }>
  expanded?: boolean
  animationsEnabled?: boolean
  isTranscriptMode?: boolean
}

export function ToolCallBlock({ item, expanded, animationsEnabled = true, isTranscriptMode = false }: ToolCallBlockProps) {
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
        <OutputBlock
          tool={item.tool}
          input={item.input}
          result={result}
          display={item.resultDisplay}
          expanded={expanded}
          isTranscriptMode={isTranscriptMode}
        />
      )}
    </Box>
  )
}

export function formatToolCallRunningDescription(tool: string, input: unknown): string {
  return getToolActivityDescription(tool, input) ?? 'running...'
}

interface OutputBlockProps {
  tool: string
  input: unknown
  result: string
  display?: ToolResultDisplay
  expanded?: boolean
  isTranscriptMode?: boolean
}

function OutputBlock({ tool, input, result, display, expanded, isTranscriptMode = false }: OutputBlockProps) {
  // Render-time customized summary. Used when the tool has no display
  // metadata (e.g. Bash) but provides a renderToolResultSummary hook.
  const customSummary = !display ? getToolResultSummary(tool, input, result, true) : null
  const collapsedSummary = display?.summary ?? customSummary

  if (display?.taskSnapshot && !expanded) {
    const hasDetail = (display.detail ?? result).trim().length > 0
    return (
      <ResponseBlock>
        <Box flexWrap="wrap">
          <Text color={theme.dimText}>{collapsedSummary}</Text>
          {hasDetail && !isTranscriptMode && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </ResponseBlock>
    )
  }

  if (display && !expanded) {
    const hasDetail = (display.detail ?? result).trim().length > 0
    return (
      <ResponseBlock>
        <Box flexWrap="wrap">
          <Text color={theme.dimText}>{collapsedSummary}</Text>
          {hasDetail && !isTranscriptMode && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
        </Box>
      </ResponseBlock>
    )
  }

  // No display metadata — render using custom summary when available.
  if (!display && customSummary && !expanded) {
    return (
      <ResponseBlock>
        <Box flexWrap="wrap">
          <Text color={theme.dimText}>{customSummary}</Text>
          {!isTranscriptMode && <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>}
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
            <Text color={theme.dimText}>{collapsedSummary}</Text>
          </Box>
          <DetailLines lines={(display.detail ?? result).split('\n')} />
          {!isTranscriptMode && (
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

  // No display metadata, expanded — show custom summary header + raw result.
  if (!display && expanded) {
    return (
      <ResponseBlock>
        <Box flexDirection="column">
          {customSummary && (
            <Box>
              <Text color={theme.dimText}>{customSummary}</Text>
            </Box>
          )}
          <DetailLines lines={lines} />
          {!isTranscriptMode && (
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

  // No display metadata, not expanded, no custom summary — fall back to raw
  // line-based collapse behavior.
  if (totalLines <= COLLAPSE_LINES) {
    return (
      <ResponseBlock>
        <Box flexDirection="column">
          <DetailLines lines={lines} />
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
            ... +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'}{!isTranscriptMode && ' (ctrl+o to expand)'}
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
