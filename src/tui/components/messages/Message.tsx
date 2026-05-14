import React, { memo } from 'react'
import { Box } from '../../ink.js'
import type { ChatMessage, ContentBlock } from './types.js'
import { UserTextMessage } from './UserTextMessage.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'
import { ToolUseMessage } from './ToolUseMessage.js'
import { ToolResultMessage } from './ToolResultMessage.js'
import { SystemMessage } from './SystemMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import { ImageMessage } from './ImageMessage.js'

type Props = {
  message: ChatMessage
  verbose?: boolean
  isRunning?: boolean
}

export const Message = memo(function Message({ message, verbose, isRunning }: Props) {
  // 系统消息
  if (message.role === 'system') {
    return <SystemMessage message={message} />
  }

  // 字符串内容（简化格式）
  if (typeof message.content === 'string') {
    if (message.role === 'user') {
      return <UserTextMessage text={message.content} />
    }
    return <AssistantTextMessage text={message.content} isStreaming={message.isStreaming} />
  }

  // 内容块数组
  return (
    <Box flexDirection="column" marginTop={1}>
      {message.content.map((block, i) => (
        <Box key={i} marginBottom={i < message.content.length - 1 ? 1 : 0}>
          <ContentBlock block={block} role={message.role} verbose={verbose} isRunning={isRunning} />
        </Box>
      ))}
    </Box>
  )
})

function ContentBlock({ block, role, verbose, isRunning }: { block: ContentBlock; role: string; verbose?: boolean; isRunning?: boolean }) {
  switch (block.type) {
    case 'text':
      return role === 'user'
        ? <UserTextMessage text={block.text} />
        : <AssistantTextMessage text={block.text} isStreaming={isRunning} />
    case 'tool_use':
      return <ToolUseMessage id={block.id} name={block.name} input={block.input} verbose={verbose} isRunning={isRunning} />
    case 'tool_result':
      return <ToolResultMessage toolUseId={block.tool_use_id} content={block.content} isError={block.is_error} />
    case 'thinking':
      return <AssistantThinkingMessage thinking={block.thinking} />
    case 'image':
      return <ImageMessage path={block.path} alt={block.alt} />
    default:
      return null
  }
}
