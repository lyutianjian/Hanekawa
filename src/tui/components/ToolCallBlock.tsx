import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import type { TUIDisplayItem, ToolCallStatus } from '../types.js'

interface ToolCallBlockProps {
  item: Extract<TUIDisplayItem, { kind: 'tool_call' }>
  expanded?: boolean
}

const COLLAPSE_LINES = 3

export function ToolCallBlock({ item, expanded }: ToolCallBlockProps) {
  const statusDot = getStatusDot(item.status)
  const inputDisplay = formatInput(item.tool, item.input)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Header: ● ToolName(input) */}
      <Box>
        <Text color={statusDot.color}>{statusDot.char} </Text>
        <Text color={theme.toolName} bold>
          {item.tool}
        </Text>
        {inputDisplay && (
          <>
            <Text color={theme.dimText}>(</Text>
            <Text color={theme.dimText}>{inputDisplay}</Text>
            <Text color={theme.dimText}>)</Text>
          </>
        )}
        <Text> </Text>
      </Box>

      {/* Running indicator */}
      {item.status === 'running' && (
        <Box paddingLeft={2}>
          <Text color={theme.warning} dimColor>
            running...
          </Text>
        </Box>
      )}

      {/* Denied indicator */}
      {item.status === 'denied' && (
        <Box paddingLeft={2}>
          <Text color={theme.error}>denied</Text>
        </Box>
      )}

      {/* Error output */}
      {item.status === 'error' && item.result && (
        <Box paddingLeft={2} flexDirection="column">
          {item.errorCode && (
            <Text color={theme.error} dimColor>
              error: {item.errorCode}
            </Text>
          )}
          <Text color={theme.error}>{formatOutput(item.result, true)}</Text>
        </Box>
      )}

      {/* Done output — collapsible */}
      {item.status === 'done' && item.result && shouldShowResult(item.tool) && (
        <OutputBlock result={item.result} expanded={expanded} />
      )}
    </Box>
  )
}

function OutputBlock({ result, expanded }: { result: string; expanded?: boolean }) {
  const lines = result.split('\n')
  const totalLines = lines.length

  if (totalLines === 0) return null

  if (expanded || totalLines <= COLLAPSE_LINES) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          <Box key={i}>
            <Text color={theme.dimText}>{'⎿  '}</Text>
            <Text color={theme.dimText}>{line}</Text>
          </Box>
        ))}
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

  // Collapsed: show first COLLAPSE_LINES + hint
  const visibleLines = lines.slice(0, COLLAPSE_LINES)
  const hiddenCount = totalLines - COLLAPSE_LINES

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visibleLines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.dimText}>{'⎿  '}</Text>
          <Text color={theme.dimText}>{line}</Text>
        </Box>
      ))}
      <Box paddingLeft={3}>
        <Text color={theme.dimText} dimColor>
          … +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'} (ctrl+o to expand)
        </Text>
      </Box>
    </Box>
  )
}

function getStatusDot(status: ToolCallStatus): { char: string; color: string } {
  switch (status) {
    case 'pending':
      return { char: '●', color: theme.dimText }
    case 'running':
      return { char: '●', color: theme.warning }
    case 'approved':
      return { char: '●', color: theme.warning }
    case 'denied':
      return { char: '●', color: theme.error }
    case 'done':
      return { char: '●', color: theme.success }
    case 'error':
      return { char: '●', color: theme.error }
  }
}

function formatInput(tool: string, input: unknown): string {
  if (!input) return ''

  if (typeof input === 'string') return truncate(input, 100)

  const obj = input as Record<string, unknown>

  // Internal tools: hide input details
  if (tool === 'TodoWrite' || tool === 'Skill') return ''

  switch (tool) {
    case 'Bash':
      return typeof obj.command === 'string' ? truncate(obj.command, 80) : ''
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Delete':
      return typeof obj.filePath === 'string'
        ? obj.filePath
        : typeof obj.path === 'string'
          ? obj.path
          : ''
    case 'Grep':
      return typeof obj.pattern === 'string' ? `"${truncate(obj.pattern, 60)}"` : ''
    case 'Glob':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    default:
      return truncate(JSON.stringify(obj), 80)
  }
}

function shouldShowResult(tool: string): boolean {
  return ['Read', 'Bash', 'Grep', 'Glob'].includes(tool)
}

function formatOutput(text: string, _alwaysShow: boolean): string {
  return text
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}
