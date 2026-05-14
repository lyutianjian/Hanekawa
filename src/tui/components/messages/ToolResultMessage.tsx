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
  const preview = isLong ? content.slice(0, 200).split('\n').slice(0, 3).join('\n') + '...' : content

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box>
        <Text color={isError ? 'red' : 'green'} dimColor>
          {isError ? '✗' : '✓'} {isError ? 'Error' : 'Done'}
        </Text>
        {isLong && <Text dimColor> ({lines.length} lines)</Text>}
      </Box>
      {isError && (
        <Box marginLeft={2}>
          <Text color="red">{preview}</Text>
        </Box>
      )}
    </Box>
  )
}
