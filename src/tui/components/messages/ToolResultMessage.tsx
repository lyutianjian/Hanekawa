import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  toolUseId: string
  content: string
  isError?: boolean
}

export function ToolResultMessage({ toolUseId, content, isError }: Props) {
  const lines = content.split('\n')
  const isLong = lines.length > 5 || content.length > 300
  const preview = isLong
    ? lines.slice(0, 3).join('\n') + (lines.length > 3 ? `\n... (${lines.length - 3} more lines)` : '')
    : content

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box borderStyle="single" borderColor="gray" paddingX={1} width="100%" flexDirection="column">
        <Box>
          <Text color={isError ? 'red' : 'green'} dimColor>
            {isError ? '✗' : '✓'} {isError ? 'Error' : 'Done'}
          </Text>
          {isLong && <Text dimColor> ({lines.length} lines)</Text>}
        </Box>
        <Box marginLeft={2} flexDirection="column">
          <Text color={isError ? 'red' : undefined} dimColor={!isError}>
            {preview}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
