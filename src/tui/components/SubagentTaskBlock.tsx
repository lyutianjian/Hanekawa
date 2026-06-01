import { Box, Text } from 'ink'
import type { TUIDisplayItem } from '../types.js'
import { theme } from '../theme.js'

type SubagentTaskItem = Extract<TUIDisplayItem, { kind: 'subagent_task' }>

export function SubagentTaskBlock({ item }: { item: SubagentTaskItem }) {
  const { record } = item
  const marker = getStatusMarker(record.status)
  const label = formatAgentLabel(record)
  const status = formatStatus(record.status)
  const details = formatDetails(item)

  return (
    <Box marginY={1} flexDirection="column">
      <Box>
        <Text color={marker.color}>{marker.char}</Text>
        <Text color={marker.color}> {label}</Text>
        <Text color={theme.taskDim}> {status}</Text>
        {details && <Text color={theme.taskDim}> · {details}</Text>}
      </Box>
    </Box>
  )
}

export function formatSubagentTaskLine(item: SubagentTaskItem): string {
  const marker = getStatusMarker(item.record.status)
  const label = formatAgentLabel(item.record)
  const status = formatStatus(item.record.status)
  const details = formatDetails(item)
  return `${marker.char} ${label} ${status}${details ? ` · ${details}` : ''}`
}

function getStatusMarker(status: SubagentTaskItem['record']['status']): { char: string; color: string } {
  switch (status) {
    case 'running':
      return { char: '●', color: theme.taskRunning }
    case 'completed':
      return { char: '✓', color: theme.taskDone }
    case 'failed':
      return { char: '✗', color: theme.taskFailed }
    case 'cancelled':
    case 'interrupted':
      return { char: '◌', color: theme.taskDim }
  }
}

function formatAgentLabel(record: SubagentTaskItem['record']): string {
  const name = record.name?.trim()
  return name && name !== record.subagentType
    ? `${name} (${record.subagentType})`
    : `${record.subagentType} agent`
}

function formatStatus(status: SubagentTaskItem['record']['status']): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'interrupted':
      return 'interrupted'
  }
}

function formatDetails(item: SubagentTaskItem): string {
  const { record } = item
  if (record.status === 'running' && item.progress) {
    const parts = [
      truncate(item.progress, 80),
      `#${record.agentId.slice(0, 8)}`,
    ]
    if (record.transcriptPath || record.worktreePath) {
      parts.push(`/agents show ${record.agentId.slice(0, 8)}`)
    }
    return parts.join(' ')
  }

  const parts: string[] = []
  if (record.verdict) parts.push(record.verdict)
  parts.push(`#${record.agentId.slice(0, 8)}`)
  if (record.transcriptPath || record.worktreePath) {
    parts.push(`/agents show ${record.agentId.slice(0, 8)}`)
  }
  return parts.join(' ')
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}
