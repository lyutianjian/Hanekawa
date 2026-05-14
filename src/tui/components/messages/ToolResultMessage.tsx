import React, { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'

type Props = {
  toolUseId: string
  content: string
  isError?: boolean
}

export function ToolResultMessage({ toolUseId, content, isError }: Props) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const isLong = lines.length > 10 || content.length > 500
  const preview = isLong ? content.slice(0, 300) + '...' : content

  useInput((input, key) => {
    if ((key.return || input === ' ') && isLong) {
      setExpanded(prev => !prev)
    }
  })

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      <Box>
        <Text color={isError ? 'red' : 'green'}>
          {isError ? '✗' : '✓'}
        </Text>
        <Text dimColor> Result</Text>
        {isLong && (
          <Text dimColor>
            {' '}[{expanded ? 'collapse' : `expand (${lines.length} lines)`}]
          </Text>
        )}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text color={isError ? 'red' : undefined}>
          {expanded ? content : preview}
        </Text>
      </Box>
    </Box>
  )
}
