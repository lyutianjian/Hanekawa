import { Box, Text } from 'ink'
import type { TUIDisplayItem } from '../types.js'
import { theme } from '../theme.js'
import { TREE_BRANCH, TREE_LAST, TREE_PIPE } from '../constants/figures.js'
import { formatTokenCount } from '../../tools/display.js'

type SubagentTaskItem = Extract<TUIDisplayItem, { kind: 'subagent_task' }>

export type SubagentTreePosition = 'first' | 'middle' | 'last' | 'only'

interface SubagentTaskBlockProps {
  item: SubagentTaskItem
  /** Tree position when multiple subagent_task items render back-to-back. */
  treePosition?: SubagentTreePosition
}

/**
 * Claude-Code-style tree rendering for a subagent task line.
 *
 * Single item:
 *   └─ explore · 5 tool uses · 2.3k tokens
 *      ⎿ Done · verdict PASS · #a1b2c3d4
 *
 * Multiple siblings:
 *   ├─ plan(routing layer) · 3 tool uses · 1.2k tokens
 *   │  ⎿ Done
 *   └─ explore · 8 tool uses · 4.1k tokens
 *      ⎿ Done · #e5f6g7h8
 */
export function SubagentTaskBlock({ item, treePosition = 'only' }: SubagentTaskBlockProps) {
  const { record } = item
  const statusColor = statusColorFor(record.status)
  const treeChar = treePosition === 'last' || treePosition === 'only' ? TREE_LAST : TREE_BRANCH
  const continuation = treePosition === 'last' || treePosition === 'only' ? '   ' : `${TREE_PIPE}  `

  const label = formatAgentLabel(record)
  const stats = formatStats(record)
  const statusText = formatStatusText(record, item.progress)
  const details = formatDetails(record)

  return (
    <Box marginY={0} flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box flexShrink={0}>
          <Text color={theme.taskDim}>{treeChar} </Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={statusColor} bold>{label}</Text>
          {stats && <Text color={theme.taskDim}> · {stats}</Text>}
        </Box>
      </Box>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box flexShrink={0}>
          <Text color={theme.taskDim}>{continuation}</Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={statusColor}>{statusText}</Text>
          {details && <Text color={theme.taskDim}> · {details}</Text>}
        </Box>
      </Box>
    </Box>
  )
}

export function formatSubagentTaskLine(item: SubagentTaskItem): string {
  const label = formatAgentLabel(item.record)
  const stats = formatStats(item.record)
  const status = formatStatusText(item.record, item.progress)
  const details = formatDetails(item.record)
  const parts = [label]
  if (stats) parts.push(stats)
  const tail = [status, details].filter(Boolean).join(' · ')
  return `${parts.join(' · ')}${tail ? `\n  ⎿  ${tail}` : ''}`
}

function statusColorFor(status: SubagentTaskItem['record']['status']): string {
  switch (status) {
    case 'running':     return theme.taskRunning
    case 'completed':   return theme.taskDone
    case 'failed':      return theme.taskFailed
    case 'cancelled':
    case 'interrupted': return theme.taskDim
  }
}

function formatAgentLabel(record: SubagentTaskItem['record']): string {
  const name = record.name?.trim()
  const baseName = name && name !== record.subagentType
    ? `${name} (${record.subagentType})`
    : `${record.subagentType} agent`
  return baseName
}

function formatStats(record: SubagentTaskItem['record']): string {
  const segments: string[] = []
  if (typeof record.toolUseCount === 'number') {
    segments.push(`${record.toolUseCount} ${record.toolUseCount === 1 ? 'tool use' : 'tool uses'}`)
  }
  if (record.usage) {
    const total = (record.usage.inputTokens ?? 0)
      + (record.usage.cacheReadInputTokens ?? 0)
      + (record.usage.outputTokens ?? 0)
    if (total > 0) segments.push(`${formatTokenCount(total)} tokens`)
  }
  if (typeof record.durationMs === 'number' && record.durationMs >= 0) {
    segments.push(`${Math.max(1, Math.round(record.durationMs / 1000))}s`)
  }
  return segments.join(' \u00b7 ')
}

function formatStatusText(
  record: SubagentTaskItem['record'],
  progress: string | undefined,
): string {
  switch (record.status) {
    case 'running':
      return progress && progress.length > 0 ? truncate(progress, 80) : 'Initializing…'
    case 'completed':
      return record.verdict ? `Done · verdict ${record.verdict}` : 'Done'
    case 'failed':
      return record.error ? `Failed: ${truncate(record.error, 80)}` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
  }
}

function formatDetails(record: SubagentTaskItem['record']): string {
  if (record.status === 'running') return ''
  const shortId = record.agentId.slice(0, 8)
  const parts = [`#${shortId}`]
  if (record.transcriptPath || record.worktreePath) {
    parts.push(`/agents show ${shortId}`)
  }
  return parts.join(' ')
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}
