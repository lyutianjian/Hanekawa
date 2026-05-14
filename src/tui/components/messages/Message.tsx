import React, { memo } from 'react'
import type { ChatMessage, ContentBlock } from './types.js'
import { UserTextMessage } from './UserTextMessage.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'
import { ToolUseMessage } from './ToolUseMessage.js'
import { ToolResultMessage } from './ToolResultMessage.js'
import { SystemMessage } from './SystemMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

type Props = {
  message: ChatMessage
  verbose?: boolean
}

export const Message = memo(function Message({ message, verbose }: Props) {
  // 系统消息
  if (message.role === 'system') {
    return <SystemMessage message={message} />
  }

  // 字符串内容（简化格式）
  if (typeof message.content === 'string') {
    if (message.role === 'user') {
      return <UserTextMessage text={message.content} />
    }
    return <AssistantTextMessage text={message.content} />
  }

  // 内容块数组
  return (
    <>
      {message.content.map((block, i) => (
        <ContentBlock key={i} block={block} role={message.role} verbose={verbose} />
      ))}
    </>
  )
})

function ContentBlock({ block, role, verbose }: { block: ContentBlock; role: string; verbose?: boolean }) {
  switch (block.type) {
    case 'text':
      return role === 'user'
        ? <UserTextMessage text={block.text} />
        : <AssistantTextMessage text={block.text} />
    case 'tool_use':
      return <ToolUseMessage id={block.id} name={block.name} input={block.input} verbose={verbose} />
    case 'tool_result':
      return <ToolResultMessage toolUseId={block.tool_use_id} content={block.content} isError={block.is_error} />
    case 'thinking':
      return <AssistantThinkingMessage thinking={block.thinking} />
    default:
      return null
  }
}
