import { Box, Text } from 'ink'
import { useState, useCallback } from 'react'
import { Message } from './Message.js'
import { ToolUseMessage } from './ToolUseMessage.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { ThemedText } from '../design-system/ThemedText.js'
import type { DisplayMessage } from '../hooks/useSession.js'

const MAX_VISIBLE_MESSAGES = 200

interface MessageListProps {
  messages: DisplayMessage[]
  streamingMessageId?: string | null
  focusedMessageId?: string | null
}

interface ToolGroup {
  toolUse: DisplayMessage
  toolResult?: DisplayMessage
}

function groupToolMessages(messages: DisplayMessage[]): Array<DisplayMessage | ToolGroup> {
  const result: Array<DisplayMessage | ToolGroup> = []
  const pendingToolUse = new Map<string, DisplayMessage>()

  for (const msg of messages) {
    if (msg.role === 'tool_use') {
      // Store pending tool_use
      pendingToolUse.set(msg.id, msg)
      result.push({ toolUse: msg })
    } else if (msg.role === 'tool_result') {
      // Find matching tool_use by toolName
      const matchingToolUse = Array.from(pendingToolUse.values()).find(
        (t) => t.toolName === msg.toolName
      )
      if (matchingToolUse) {
        // Update the existing group with the result
        const group = result.find(
          (g) => typeof g === 'object' && 'toolUse' in g && g.toolUse.id === matchingToolUse.id
        ) as ToolGroup | undefined
        if (group) {
          group.toolResult = msg
        }
        pendingToolUse.delete(matchingToolUse.id)
      } else {
        // Standalone tool_result
        result.push(msg)
      }
    } else {
      result.push(msg)
    }
  }

  return result
}

export function MessageList({ messages, streamingMessageId, focusedMessageId }: MessageListProps) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((id: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  if (messages.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Welcome to MyAgent TUI. Type a message to get started.</Text>
      </Box>
    )
  }

  const hiddenCount = Math.max(0, messages.length - MAX_VISIBLE_MESSAGES)
  const visibleMessages = hiddenCount > 0
    ? messages.slice(hiddenCount)
    : messages

  const grouped = groupToolMessages(visibleMessages)
  const elements: React.ReactNode[] = []

  for (const item of grouped) {
    // Handle tool groups
    if (typeof item === 'object' && 'toolUse' in item) {
      const group = item as ToolGroup
      const isFocused = group.toolUse.id === focusedMessageId
      const isExpanded = expandedTools.has(group.toolUse.id)
      elements.push(
        <ErrorBoundary
          key={group.toolUse.id}
          fallback={
            <Box paddingY={1}>
              <Text color="red">⚠ Failed to render tool message</Text>
            </Box>
          }
        >
          <ToolUseMessage
            toolName={group.toolUse.toolName ?? 'unknown'}
            input={group.toolUse.toolInput}
            output={group.toolResult?.content}
            ok={group.toolResult?.toolOk}
            isFocused={isFocused}
            isExpanded={isExpanded}
            onToggleExpand={() => toggleExpand(group.toolUse.id)}
          />
        </ErrorBoundary>,
      )
      continue
    }

    // Handle regular messages
    const msg = item as DisplayMessage
    elements.push(
      <ErrorBoundary
        key={msg.id}
        fallback={
          <Box paddingY={1}>
            <Text color="red">⚠ Failed to render message</Text>
          </Box>
        }
      >
        <Message
          message={msg}
          isStreaming={msg.id === streamingMessageId}
        />
      </ErrorBoundary>,
    )
  }

  return (
    <Box flexDirection="column">
      {hiddenCount > 0 && (
        <Box paddingX={1}>
          <ThemedText color="dimmed">[{hiddenCount} earlier messages hidden]</ThemedText>
        </Box>
      )}
      {elements}
    </Box>
  )
}
