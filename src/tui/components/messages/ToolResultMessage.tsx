import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  toolUseId: string
  content: string
  isError?: boolean
}

export function ToolResultMessage({ toolUseId, content, isError }: Props) {
  const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      <Box>
        <Text color={isError ? 'red' : 'green'}>
          {isError ? '✗ ' : '✓ '}
        </Text>
        <Text dimColor>Result</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={isError ? 'red' : undefined}>{truncated}</Text>
      </Box>
    </Box>
  )
}
