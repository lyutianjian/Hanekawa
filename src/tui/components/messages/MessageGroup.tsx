import React, { memo } from 'react'
import { Box, Text } from '../../ink.js'
import type { ChatMessage } from './types.js'
import { Message } from './Message.js'

type Props = {
  messages: ChatMessage[]
  role: 'user' | 'assistant' | 'system'
  verbose?: boolean
  columns?: number
}

/**
 * 消息分组组件 — 将连续同角色消息合并显示
 * 复刻自 ClaudeCode 的消息分组逻辑
 */
export const MessageGroup = memo(function MessageGroup({ messages, role, verbose, columns }: Props) {
  if (messages.length === 0) return null

  // 单条消息直接渲染
  if (messages.length === 1) {
    return <Message message={messages[0]} verbose={verbose} />
  }

  // 多条同角色消息：显示角色标签一次，内容合并
  const borderColor = role === 'user' ? 'blue' : role === 'assistant' ? 'green' : 'gray'
  const label = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'System'

  return (
    <Box flexDirection="row" marginBottom={1} paddingX={1}>
      <Text color={borderColor as any} bold>│</Text>
      <Box flexDirection="column" marginLeft={1}>
        <Text color={borderColor as any} bold>{label}</Text>
        {messages.map((msg, i) => (
          <Box key={msg.id} marginTop={i > 0 ? 1 : 0}>
            <Message message={msg} verbose={verbose} />
          </Box>
        ))}
      </Box>
    </Box>
  )
})
