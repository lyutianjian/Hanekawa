import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  id: string
  name: string
  input: unknown
  verbose?: boolean
}

export function ToolUseMessage({ id, name, input, verbose }: Props) {
  const [expanded, setExpanded] = useState(false)

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const truncated = !verbose && inputStr.length > 200
  const displayInput = truncated ? inputStr.slice(0, 200) + '...' : inputStr

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      <Box>
        <Text color="yellow">{'⚡ '}</Text>
        <Text bold color="yellow">{name}</Text>
        <Text dimColor> ({id.slice(0, 8)})</Text>
      </Box>
      {verbose && (
        <Box marginLeft={2}>
          <Text dimColor>{displayInput}</Text>
        </Box>
      )}
    </Box>
  )
}
