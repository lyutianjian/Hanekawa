import React, { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'

type Props = {
  thinking: string
  defaultExpanded?: boolean
}

export function AssistantThinkingMessage({ thinking, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  useInput((input, key) => {
    if (key.return || input === ' ') {
      setExpanded(prev => !prev)
    }
  })

  if (!thinking.trim()) return null

  const lines = thinking.split('\n')
  const preview = lines[0].slice(0, 80) + (lines[0].length > 80 ? '...' : '')

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      <Box>
        <Text dimColor bold>
          {expanded ? '▼' : '▶'} Thinking
        </Text>
        {!expanded && (
          <Text dimColor> — {preview}</Text>
        )}
      </Box>
      {expanded && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {lines.map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
