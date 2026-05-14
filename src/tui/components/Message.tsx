import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import { SystemMessage } from './SystemMessage.js'
import { ToolUseMessage } from './ToolUseMessage.js'
import type { DisplayMessage } from '../hooks/useSession.js'

interface MessageProps {
  message: DisplayMessage
  isStreaming?: boolean
}

export function Message({ message, isStreaming }: MessageProps) {
  switch (message.role) {
    case 'user':
      return <UserMessage content={message.content ?? ''} />

    case 'assistant':
      return <AssistantMessage content={message.content ?? ''} isStreaming={isStreaming} />

    case 'system':
      return <SystemMessage content={message.content ?? ''} />

    case 'tool_use':
      return (
        <ToolUseMessage
          toolName={message.toolName ?? 'unknown'}
          input={message.toolInput}
        />
      )

    case 'tool_result':
      return (
        <ToolUseMessage
          toolName={message.toolName ?? 'unknown'}
          output={message.content}
          ok={message.toolOk}
        />
      )

    default:
      return <SystemMessage content={message.content ?? ''} variant="warning" />
  }
}
