import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  text: string
}

export function UserTextMessage({ text }: Props) {
  const lines = text.split('\n')
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="blue"> {'│'} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  )
}
