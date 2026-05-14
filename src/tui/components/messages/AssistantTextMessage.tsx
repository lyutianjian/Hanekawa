import React, { useState, useEffect } from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown, StreamingMarkdown } from '../Markdown.js'

type Props = {
  text: string
  isStreaming?: boolean
}

function BlinkingCursor() {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => setVisible(v => !v), 530)
    return () => clearInterval(interval)
  }, [])

  return <Text color="green" bold>{visible ? '█' : ' '}</Text>
}

export function AssistantTextMessage({ text, isStreaming }: Props) {
  if (!text.trim()) return null

  return (
    <Box flexDirection="row" marginBottom={1} paddingX={1}>
      <Text color="green" bold>│</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color="green" bold>Assistant</Text>
        {isStreaming ? (
          <Box>
            <StreamingMarkdown>{text}</StreamingMarkdown>
            <BlinkingCursor />
          </Box>
        ) : (
          <Markdown>{text}</Markdown>
        )}
      </Box>
    </Box>
  )
}
