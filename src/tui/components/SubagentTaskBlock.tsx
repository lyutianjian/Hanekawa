import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { TUIDisplayItem } from '../types.js'
import { theme } from '../theme.js'
import { INDENT_TOOL, STATUS_DOT, TREE_LAST } from '../constants/figures.js'
import { formatTokenCount } from '../../tools/display.js'

type SubagentTaskItem = Extract<TUIDisplayItem, { kind: 'subagent_task' }>

export type SubagentTreePosition = 'first' | 'middle' | 'last' | 'only'

interface SubagentTaskBlockProps {
  item: SubagentTaskItem
  treePosition?: SubagentTreePosition
  expanded?: boolean
  isTranscriptMode?: boolean
}

export function SubagentTaskBlock({ item, expanded = false, isTranscriptMode = false }: SubagentTaskBlockProps) {
  const { record } = item
  const statusColor = getSubagentStatusColor(record.status)
  const label = formatAgentLabel(record)
  const model = record.model?.trim()
  const statusText = formatStatusText(record, item.progress)
  const response = formatResponseText(record, item.progress)

  return (
    <Box marginBottom={1} flexDirection="column" paddingLeft={INDENT_TOOL}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2} flexShrink={0}>
          <Text color={statusColor}>{STATUS_DOT}</Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={statusColor} bold>{label}</Text>
          {model && <Text color={theme.dimText}> {model}</Text>}
        </Box>
      </Box>

      {!expanded && (
        <SubagentTreeLine>
          {statusText}
          {record.status === 'completed' && !isTranscriptMode && (
            <Text color={theme.dimText} dimColor> (ctrl+o to expand)</Text>
          )}
        </SubagentTreeLine>
      )}

      {expanded && (
        <>
          <SubagentSection label="Prompt:" />
          <IndentedText text={record.task} />
          {response && (
            <>
              <SubagentSection label="Response:" />
              <IndentedText text={response} />
            </>
          )}
          <SubagentTreeLine>{statusText}</SubagentTreeLine>
          {record.status === 'completed' && !isTranscriptMode && (
            <Box paddingLeft={3}>
              <Text color={theme.dimText} dimColor>
                (ctrl+o to collapse)
              </Text>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}

export function formatSubagentTaskLine(item: SubagentTaskItem): string {
  const label = formatAgentLabel(item.record)
  const model = item.record.model?.trim()
  const status = formatStatusText(item.record, item.progress)
  return `${[label, model].filter(Boolean).join(' ')}\n  ${TREE_LAST} ${status}`
}

export function getSubagentStatusColor(status: SubagentTaskItem['record']['status']): string {
  switch (status) {
    case 'running':     return theme.taskRunning
    case 'completed':   return theme.statusDotSuccess
    case 'failed':      return theme.statusDotFailed
    case 'cancelled':
    case 'interrupted': return theme.taskDim
  }
}

function formatAgentLabel(record: SubagentTaskItem['record']): string {
  const summary = truncate((record.description || record.name || record.task).trim(), 36)
  return summary ? `${record.subagentType} agent(${summary})` : `${record.subagentType} agent`
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
  return segments.join(' · ')
}

function formatStatusText(
  record: SubagentTaskItem['record'],
  progress: string | undefined,
): string {
  switch (record.status) {
    case 'running':
      return progress && progress.length > 0 ? truncate(progress, 80) : 'Initializing...'
    case 'completed':
      return formatDoneStatus(record)
    case 'failed':
      return record.error ? `Failed: ${truncate(record.error, 80)}` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
  }
}

function formatDoneStatus(record: SubagentTaskItem['record']): string {
  const stats = formatStats(record)
  return stats ? `Done (${stats})` : 'Done'
}

function formatResponseText(record: SubagentTaskItem['record'], progress: string | undefined): string {
  if (record.status === 'completed') return record.summary?.trim() ?? ''
  if (record.status === 'failed') return record.error?.trim() ?? ''
  if (record.status === 'running') return progress?.trim() ?? ''
  return ''
}

function SubagentTreeLine({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box flexShrink={0}>
        <Text color={theme.taskDim}>{TREE_LAST} </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={theme.dimText}>{children}</Text>
      </Box>
    </Box>
  )
}

function SubagentSection({ label }: { label: string }) {
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box flexShrink={0}>
        <Text color={theme.taskDim}>{TREE_LAST} </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={theme.success} bold>{label}</Text>
      </Box>
    </Box>
  )
}

function IndentedText({ text }: { text: string }) {
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {text.split('\n').map((line, index) => (
        <Box key={index}>
          <Text color={theme.dimText}>{line}</Text>
        </Box>
      ))}
    </Box>
  )
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}
