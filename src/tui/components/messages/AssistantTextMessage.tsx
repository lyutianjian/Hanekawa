import React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
}

export function AssistantTextMessage({ text }: Props) {
  if (!text.trim()) return null

  return (
    <Box flexDirection="row" marginBottom={1} paddingX={1}>
      <Text color="green" bold>│</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color="green" bold>Assistant</Text>
        <Markdown>{text}</Markdown>
      </Box>
    </Box>
  )
}
