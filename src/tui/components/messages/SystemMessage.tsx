import React from 'react'
import { Box, Text } from '../../ink.js'
import type { ChatMessage } from './types.js'

type Props = {
  message: ChatMessage
}

export function SystemMessage({ message }: Props) {
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n')

  if (!text.trim()) return null

  return (
    <Box marginBottom={1} paddingX={1}>
      <Text dimColor italic>{text}</Text>
    </Box>
  )
}
