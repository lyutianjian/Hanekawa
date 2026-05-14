import React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'

type Props = {
  text: string
}

export function AssistantTextMessage({ text }: Props) {
  if (!text.trim()) return null

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text bold color="green">{'<'} </Text>
      <Box flexDirection="column">
        <Markdown>{text}</Markdown>
      </Box>
    </Box>
  )
}
