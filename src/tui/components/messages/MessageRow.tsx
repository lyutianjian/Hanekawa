import React, { memo } from 'react'
import { Box } from '../../ink.js'
import type { ChatMessage } from './types.js'
import { Message } from './Message.js'

type Props = {
  message: ChatMessage
  verbose?: boolean
}

export const MessageRow = memo(function MessageRow({ message, verbose }: Props) {
  return (
    <Box flexDirection="column">
      <Message message={message} verbose={verbose} isRunning={message.toolStatus === 'running'} />
    </Box>
  )
})
