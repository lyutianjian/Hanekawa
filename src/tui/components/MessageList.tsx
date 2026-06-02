import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TUIDisplayItem, TUIStaticItem } from '../types.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ToolCallBlock } from './ToolCallBlock.js'
import { SubagentTaskBlock } from './SubagentTaskBlock.js'
import { WelcomeBanner } from './WelcomeBanner.js'
import { theme } from '../theme.js'

interface MessageListProps {
  items: TUIDisplayItem[]
  recentCompletedToolCall?: Extract<TUIDisplayItem, { kind: 'tool_call' }> | null
  isOverlayActive?: boolean
}

export function MessageList({ items, recentCompletedToolCall, isOverlayActive }: MessageListProps) {
  const [previewToolUseId, setPreviewToolUseId] = useState<string | null>(null)

  // Ctrl+O now shows a live preview for the most recently completed tool call.
  // Static scrollback stays immutable once it has been printed.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') {
        if (recentCompletedToolCall?.result) {
          setPreviewToolUseId((current) =>
            current === recentCompletedToolCall.toolUseId ? null : recentCompletedToolCall.toolUseId,
          )
        }
      }
    },
    { isActive: !isOverlayActive },
  )

  const previewItem = recentCompletedToolCall?.result && previewToolUseId === recentCompletedToolCall.toolUseId
    ? recentCompletedToolCall
    : null

  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <DisplayItem
          key={item.id}
          item={item}
        />
      ))}
      {previewItem && (
        <DisplayItem
          key={`tool-preview-${previewItem.toolUseId}`}
          item={previewItem}
          expanded
        />
      )}
    </Box>
  )
}

export function DisplayItem({ item, expanded = false }: { item: TUIDisplayItem; expanded?: boolean }) {
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

export function StaticDisplayItem({ item }: { item: TUIStaticItem }) {
  if (item.kind === 'welcome_banner') {
    return (
      <WelcomeBanner
        sessionShortId={item.sessionShortId}
        model={item.model}
        providerName={item.providerName}
        cwd={item.cwd}
      />
    )
  }

  return <DisplayItem item={item} />
}

function formatCompactFailure(record: Extract<TUIDisplayItem, { kind: 'compact_attempt_failed' }>['record']): string {
  const status = record.circuitOpen
    ? 'Auto-compact failed and the failure circuit is now open.'
    : 'Auto-compact failed; continuing without compaction.'
  return `${status} Failure ${record.failureCount}, pre-compact estimate ${record.preTokens.toLocaleString()} tokens. ${record.error}`
}
