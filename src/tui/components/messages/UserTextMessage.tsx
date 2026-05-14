import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  text: string
}

export function UserTextMessage({ text }: Props) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text bold color="blue">{'>'} </Text>
      <Text>{text}</Text>
    </Box>
  )
}
