import React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
}

export function AssistantTextMessage({ text }: Props) {
  if (!text.trim()) return null

  const lines = text.split('\n')
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="green"> {'│'} </Text>
          <Markdown>{line}</Markdown>
        </Box>
      ))}
    </Box>
  )
}
