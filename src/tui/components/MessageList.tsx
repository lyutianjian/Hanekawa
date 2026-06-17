import { useMemo } from 'react'
import { Box, Text } from 'ink'
import type { TUIDisplayItem, TUIStaticItem } from '../types.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ToolCallBlock } from './ToolCallBlock.js'
import { CollapsedToolGroup } from './CollapsedToolGroup.js'
import { SubagentTaskBlock, type SubagentTreePosition } from './SubagentTaskBlock.js'
import { WelcomeBanner } from './WelcomeBanner.js'
import { theme } from '../theme.js'

interface MessageListProps {
  items: TUIDisplayItem[]
  isStreaming?: boolean
  isOverlayActive?: boolean
  animationsEnabled?: boolean
}

export function MessageList({
  items,
  isStreaming,
  animationsEnabled = true,
}: MessageListProps) {
  const subagentTreePositions = useMemo(() => computeSubagentTreePositions(items), [items])

  return (
    <Box flexDirection="column">
      {items.map((item) => {
        const isLiveThinking = isStreaming && item.kind === 'assistant' && Boolean(item.thinkingBlocks?.length)
        return (
          <DisplayItem
            key={item.id}
            item={item}
            expanded={isLiveThinking}
            animationsEnabled={animationsEnabled}
            subagentTreePosition={item.kind === 'subagent_task' ? subagentTreePositions.get(item.id) : undefined}
          />
        )
      })}
    </Box>
  )
}

export function DisplayItem({
  item,
  expanded = false,
  animationsEnabled = true,
  subagentTreePosition,
  isTranscriptMode = false,
}: {
  item: TUIDisplayItem
  expanded?: boolean
  animationsEnabled?: boolean
  subagentTreePosition?: SubagentTreePosition
  isTranscriptMode?: boolean
}) {
  const isExpanded = expanded || isTranscriptMode
  switch (item.kind) {
    case 'user':
      return <UserMessage content={item.content} />
    case 'assistant':
      return <AssistantMessage content={item.content} thinkingBlocks={item.thinkingBlocks} thinkingDurationMs={item.thinkingDurationMs} thinkingExpanded={isExpanded} thinkingPreview={item.thinkingPreview} isTranscriptMode={isTranscriptMode} />
    case 'tool_call':
      return <ToolCallBlock item={item} expanded={isExpanded} animationsEnabled={animationsEnabled} isTranscriptMode={isTranscriptMode} />
    case 'tool_group':
      return <CollapsedToolGroup item={item} expanded={isExpanded} animationsEnabled={animationsEnabled} isTranscriptMode={isTranscriptMode} />
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
      return <SubagentTaskBlock item={item} treePosition={subagentTreePosition} expanded={isExpanded} isTranscriptMode={isTranscriptMode} />
    case 'system':
      return (
        <Box marginY={1}>
          <Text color={item.content.startsWith('✻') ? theme.subtleText : theme.systemText} dimColor={!item.content.startsWith('✻')}>
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

  return <DisplayItem item={item} expanded={'expanded' in item ? item.expanded : undefined} />
}

function formatCompactFailure(record: Extract<TUIDisplayItem, { kind: 'compact_attempt_failed' }>['record']): string {
  const status = record.circuitOpen
    ? 'Auto-compact failed and the failure circuit is now open.'
    : 'Auto-compact failed; continuing without compaction.'
  return `${status} Failure ${record.failureCount}, pre-compact estimate ${record.preTokens.toLocaleString()} tokens. ${record.error}`
}

function computeSubagentTreePositions(items: TUIDisplayItem[]): Map<string, SubagentTreePosition> {
  const positions = new Map<string, SubagentTreePosition>()
  let runStart = -1
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'subagent_task') {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      annotateRun(items, runStart, i - 1, positions)
      runStart = -1
    }
  }
  if (runStart >= 0) annotateRun(items, runStart, items.length - 1, positions)
  return positions
}

function annotateRun(
  items: TUIDisplayItem[],
  start: number,
  end: number,
  positions: Map<string, SubagentTreePosition>,
): void {
  const length = end - start + 1
  for (let i = start; i <= end; i++) {
    const item = items[i]!
    let position: SubagentTreePosition
    if (length === 1) position = 'only'
    else if (i === start) position = 'first'
    else if (i === end) position = 'last'
    else position = 'middle'
    positions.set(item.id, position)
  }
}
