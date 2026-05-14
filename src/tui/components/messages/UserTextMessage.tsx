import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  text: string
}

export function UserTextMessage({ text }: Props) {
  return (
    <Box flexDirection="row" marginBottom={1} paddingX={1}>
      <Text color="blue" bold>│</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color="blue" bold>You</Text>
        <Text>{text}</Text>
      </Box>
    </Box>
  )
}
