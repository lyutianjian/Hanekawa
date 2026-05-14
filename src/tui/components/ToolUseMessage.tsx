import { Box, Text } from 'ink'
import { useState, useEffect } from 'react'
import { ThemedText } from '../design-system/ThemedText.js'
import { useTheme } from '../design-system/ThemeProvider.js'

interface ToolUseMessageProps {
  toolName: string
  input?: unknown
  output?: string
  ok?: boolean
  isFocused?: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
}

export function ToolUseMessage({
  toolName,
  input,
  output,
  ok,
  isFocused = false,
  isExpanded: isExpandedProp = false,
  onToggleExpand,
}: ToolUseMessageProps) {
  const [blinkOn, setBlinkOn] = useState(true)
  const isInProgress = ok === undefined
  const autoExpand = ok === false
  const isExpanded = isExpandedProp || autoExpand
  const { colors } = useTheme()

  useEffect(() => {
    if (!isInProgress) return
    const timer = setInterval(() => {
      setBlinkOn((prev) => !prev)
    }, 500)
    return () => clearInterval(timer)
  }, [isInProgress])

  const statusIcon = isInProgress
    ? (blinkOn ? '●' : '○')
    : ok ? '✓' : '✗'
  const statusColor = isInProgress ? colors.warning : ok ? colors.success : colors.error

  return (
    <Box
      flexDirection="column"
      paddingY={1}
      borderStyle={isFocused ? 'single' : undefined}
      borderColor={isFocused ? colors.accent : undefined}
    >
      <Box flexDirection="row">
        <ThemedText color="dimmed">{'⎿  '}</ThemedText>
        <Text color={statusColor}>{statusIcon}</Text>
        <Box marginLeft={1}>
          <ThemedText color="accent" bold>{toolName}</ThemedText>
        </Box>
        {input !== undefined && input !== null && !isExpanded && (
          <ThemedText color="dimmed"> {formatToolInput(input)}</ThemedText>
        )}
        {isFocused && (
          <Box marginLeft={1}>
            <ThemedText color="dimmed">
              [{isExpanded ? '▼' : '▶'}]
            </ThemedText>
          </Box>
        )}
      </Box>

      {isExpanded && input !== undefined && input !== null && (
        <Box flexDirection="column" marginLeft={4} marginTop={1}>
          <Box flexDirection="row">
            <ThemedText color="dimmed">Input:</ThemedText>
          </Box>
          <Box marginLeft={2}>
            <ThemedText color="foreground">
              {JSON.stringify(input, null, 2)}
            </ThemedText>
          </Box>

          {output && (
            <>
              <Box flexDirection="row" marginTop={1}>
                <ThemedText color="dimmed">Output:</ThemedText>
              </Box>
              <Box marginLeft={2}>
                <ThemedText color={ok ? 'success' : 'error'}>
                  {output}
                </ThemedText>
              </Box>
            </>
          )}
        </Box>
      )}

      {!isExpanded && ok !== undefined && !ok && output && (
        <Box marginLeft={4} marginTop={1}>
          <ThemedText color="error" dimColor>
            Error: {output.slice(0, 100)}{output.length > 100 ? '...' : ''}
          </ThemedText>
        </Box>
      )}
    </Box>
  )
}

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') {
    const truncated = input.length > 120 ? input.slice(0, 120) + '…' : input
    return truncated.replace(/\n/g, ' ')
  }

  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return ''

    const preview = keys.slice(0, 3).map(key => {
      const value = record[key]
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${valueStr.slice(0, 30)}${valueStr.length > 30 ? '...' : ''}`
    })

    return preview.join(', ') + (keys.length > 3 ? ` (+${keys.length - 3} more)` : '')
  }

  const str = JSON.stringify(input)
  return str.length > 120 ? str.slice(0, 120) + '…' : str
}
