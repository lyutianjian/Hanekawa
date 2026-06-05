import { useState, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
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
  recentCompletedToolCall?: Extract<TUIDisplayItem, { kind: 'tool_call' }> | null
  recentCompletedToolGroup?: Extract<TUIDisplayItem, { kind: 'tool_group' }> | null
  recentThinkingAssistant?: Extract<TUIDisplayItem, { kind: 'assistant' }> | null
  isStreaming?: boolean
  isOverlayActive?: boolean
  animationsEnabled?: boolean
}

type PreviewTarget =
  | { kind: 'tool'; key: string; item: Extract<TUIDisplayItem, { kind: 'tool_call' }> }
  | { kind: 'tool_group'; key: string; item: Extract<TUIDisplayItem, { kind: 'tool_group' }> }
  | { kind: 'thinking'; key: string; item: Extract<TUIDisplayItem, { kind: 'assistant' }> }

export function MessageList({
  items,
  recentCompletedToolCall,
  recentCompletedToolGroup,
  recentThinkingAssistant,
  isStreaming,
  isOverlayActive,
  animationsEnabled = true,
}: MessageListProps) {
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const latestPreviewTarget = getLatestPreviewTarget(
    recentCompletedToolCall,
    recentCompletedToolGroup,
    recentThinkingAssistant,
  )

  // Ctrl+O shows a live preview for the most recent expandable item.
  // Static scrollback stays immutable once it has been printed.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') {
        if (!latestPreviewTarget) return
        setPreviewKey((current) =>
          current === latestPreviewTarget.key ? null : latestPreviewTarget.key,
        )
      }
    },
    { isActive: !isOverlayActive },
  )

  const previewTarget = latestPreviewTarget?.key === previewKey ? latestPreviewTarget : null

  const subagentTreePositions = useMemo(() => computeSubagentTreePositions(items), [items])

  return (
    <Box flexDirection="column">
      {items.map((item) => {
        const isLatestThinking = previewTarget?.kind === 'thinking' && previewTarget.item.id === item.id
        const isLiveThinking = isStreaming && item.kind === 'assistant' && Boolean(item.thinkingBlocks?.length) && recentThinkingAssistant?.id === item.id
        const isLatestGroup = previewTarget?.kind === 'tool_group' && previewTarget.item.id === item.id
        return (
          <DisplayItem
            key={item.id}
            item={item}
            expanded={isLatestThinking || isLiveThinking || isLatestGroup}
            animationsEnabled={animationsEnabled}
            subagentTreePosition={item.kind === 'subagent_task' ? subagentTreePositions.get(item.id) : undefined}
          />
        )
      })}
      {previewTarget?.kind === 'tool' && (
        <DisplayItem
          key={`preview-${previewTarget.key}`}
          item={previewTarget.item}
          expanded
          animationsEnabled={animationsEnabled}
        />
      )}
      {previewTarget?.kind === 'tool_group' && (
        <DisplayItem
          key={`preview-${previewTarget.key}`}
          item={previewTarget.item}
          expanded
          animationsEnabled={animationsEnabled}
        />
      )}
      {previewTarget?.kind === 'thinking' && !items.some((item) => item.id === previewTarget.item.id) && (
        <DisplayItem
          key={`preview-${previewTarget.key}`}
          item={previewTarget.item}
          expanded
          animationsEnabled={animationsEnabled}
        />
      )}
    </Box>
  )
}

export function DisplayItem({
  item,
  expanded = false,
  animationsEnabled = true,
  subagentTreePosition,
}: {
  item: TUIDisplayItem
  expanded?: boolean
  animationsEnabled?: boolean
  subagentTreePosition?: SubagentTreePosition
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage content={item.content} />
    case 'assistant':
      return <AssistantMessage content={item.content} thinkingBlocks={item.thinkingBlocks} thinkingDurationMs={item.thinkingDurationMs} thinkingExpanded={expanded} thinkingPreview={item.thinkingPreview} />
    case 'tool_call':
      return <ToolCallBlock item={item} expanded={expanded} animationsEnabled={animationsEnabled} />
    case 'tool_group':
      return <CollapsedToolGroup item={item} expanded={expanded} animationsEnabled={animationsEnabled} />
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
      return <SubagentTaskBlock item={item} treePosition={subagentTreePosition} />
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

function getLatestPreviewTarget(
  tool: Extract<TUIDisplayItem, { kind: 'tool_call' }> | null | undefined,
  toolGroup: Extract<TUIDisplayItem, { kind: 'tool_group' }> | null | undefined,
  assistant: Extract<TUIDisplayItem, { kind: 'assistant' }> | null | undefined,
): PreviewTarget | null {
  const toolTarget = tool?.result
    ? { kind: 'tool' as const, key: `tool:${tool.toolUseId}`, item: tool, createdAt: tool.createdAt }
    : null
  const groupTarget = toolGroup && toolGroup.toolCalls.length > 0
    ? { kind: 'tool_group' as const, key: `group:${toolGroup.id}`, item: toolGroup, createdAt: toolGroup.createdAt }
    : null
  const thinkingTarget = assistant?.thinkingBlocks && assistant.thinkingBlocks.length > 0
    ? { kind: 'thinking' as const, key: `thinking:${assistant.id}`, item: assistant, createdAt: assistant.createdAt }
    : null

  const candidates = [toolTarget, groupTarget, thinkingTarget].filter(
    (target): target is NonNullable<typeof target> => target !== null,
  )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
  const latest = candidates[0]!
  // Drop the transient `createdAt` before returning.
  return { kind: latest.kind, key: latest.key, item: latest.item } as PreviewTarget
}

function timestampMs(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
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
