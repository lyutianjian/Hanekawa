import React, { memo } from 'react'
import { Box, Text } from '../../ink.js'
import type { ChatMessage } from './types.js'
import { Message } from './Message.js'

type Props = {
  message: ChatMessage
  verbose?: boolean
  showTimestamp?: boolean
}

export const MessageRow = memo(function MessageRow({ message, verbose, showTimestamp }: Props) {
  return (
    <Box flexDirection="column">
      {showTimestamp && message.timestamp && (
        <Text dimColor>
          {new Date(message.timestamp).toLocaleTimeString()}
        </Text>
      )}
      <Message message={message} verbose={verbose} isRunning={message.toolStatus === 'running'} />
    </Box>
  )
})
