import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

type Props = {
  initialText: string
  onSubmit: (text: string) => void
  onCancel: () => void
}

export function MessageEditor({ initialText, onSubmit, onCancel }: Props) {
  const [text, setText] = useState(initialText)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return && !key.shift) {
      onSubmit(text)
      return
    }
    if (key.backspace) {
      setText(prev => prev.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setText(prev => prev + input)
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Edit Message</Text>
      <Box marginTop={1}>
        <Text>{text}</Text>
        <Text inverse>{' '}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter: save · Esc: cancel</Text>
      </Box>
    </Box>
  )
}
