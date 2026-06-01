import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TUIDisplayItem } from '../types.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ToolCallBlock } from './ToolCallBlock.js'
import { SubagentTaskBlock } from './SubagentTaskBlock.js'
import { theme } from '../theme.js'

interface MessageListProps {
  items: TUIDisplayItem[]
  isOverlayActive?: boolean
}

export function MessageList({ items, isOverlayActive }: MessageListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Ctrl+O to toggle expand/collapse of the last completed tool call
  // Disabled when an overlay (permission dialog, restore mode, etc.) is active
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') {
        const lastToolCall = [...items]
          .reverse()
          .find((i) => i.kind === 'tool_call' && i.result)
        if (lastToolCall) {
          setExpandedIds((prev) => {
            const next = new Set(prev)
            if (next.has(lastToolCall.id)) {
              next.delete(lastToolCall.id)
            } else {
              next.add(lastToolCall.id)
            }
            return next
          })
        }
      }
    },
    { isActive: !isOverlayActive },
  )

  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <DisplayItem
          key={item.id}
          item={item}
          expanded={expandedIds.has(item.id)}
        />
      ))}
    </Box>
  )
}

function DisplayItem({ item, expanded }: { item: TUIDisplayItem; expanded: boolean }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage content={item.content} />
    case 'assistant':
      return <AssistantMessage content={item.content} />
    case 'tool_call':
      return <ToolCallBlock item={item} expanded={expanded} />
    case 'compact_boundary':
      return (
        <Box marginY={1}>
          <Text color={theme.dimText} dimColor>
            {'--- context compacted ---'}
          </Text>
        </Box>
      )
    case 'compact_attempt_failed':
      return (
        <Box marginY={1}>
          <Text color={theme.warning}>
            {formatCompactFailure(item.record)}
          </Text>
        </Box>
      )
    case 'tool_progress':
      return (
        <Box paddingLeft={2}>
          <Text color={theme.warning} dimColor>
            {item.content}
          </Text>
        </Box>
      )
    case 'subagent_task':
      return <SubagentTaskBlock item={item} />
    case 'system':
      return (
        <Box marginY={1}>
          <Text color={theme.systemText} dimColor>
            {item.content}
          </Text>
        </Box>
      )
    case 'error':
      return (
        <Box marginY={1}>
          <Text color={theme.error}>
            Error: {item.content}
          </Text>
        </Box>
      )
  }
}

function formatCompactFailure(record: Extract<TUIDisplayItem, { kind: 'compact_attempt_failed' }>['record']): string {
  const status = record.circuitOpen
    ? 'Auto-compact failed and the failure circuit is now open.'
    : 'Auto-compact failed; continuing without compaction.'
  return `${status} Failure ${record.failureCount}, pre-compact estimate ${record.preTokens.toLocaleString()} tokens. ${record.error}`
}
