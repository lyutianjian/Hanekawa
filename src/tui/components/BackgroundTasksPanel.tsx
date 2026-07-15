import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import { theme } from '../theme.js'
import { commandVisibleRows, CommandListItem, CommandPane, getVisibleWindow } from './CommandUI.js'

interface BackgroundTasksPanelProps {
  tasks: readonly BackgroundTaskSnapshot[]
  peekOutput: (taskId: string) => string
  onClose: () => void
}

export function sortBackgroundTasks(tasks: readonly BackgroundTaskSnapshot[]): BackgroundTaskSnapshot[] {
  return [...tasks].sort((a, b) => {
    const runningRank = Number(b.status === 'running') - Number(a.status === 'running')
    return runningRank || b.startedAt - a.startedAt
  })
}

export function BackgroundTasksPanel({ tasks, peekOutput, onClose }: BackgroundTasksPanelProps) {
  const sorted = useMemo(() => sortBackgroundTasks(tasks), [tasks])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [detail, setDetail] = useState(false)
  const { stdout } = useStdout()

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, sorted.length - 1)))
  }, [sorted.length])

  useInput((_input, key) => {
    if (key.escape) {
      if (detail) setDetail(false)
      else onClose()
      return
    }
    if (detail) return
    if (key.upArrow) setSelectedIndex((current) => Math.max(0, current - 1))
    if (key.downArrow) setSelectedIndex((current) => Math.min(sorted.length - 1, current + 1))
    if (key.return && sorted[selectedIndex]) setDetail(true)
  })

  const selected = sorted[selectedIndex]
  const visibleCount = commandVisibleRows(stdout.rows, 9, 10)
  const window = getVisibleWindow(sorted.length, selectedIndex, visibleCount)
  const visibleTasks = sorted.slice(window.start, window.end)
  const runningCount = sorted.filter((task) => task.status === 'running').length
  return (
    <CommandPane
      title="Background tasks"
      subtitle={sorted.length === 0
        ? 'No active or recent tasks.'
        : `${sorted.length} task${sorted.length === 1 ? '' : 's'} · ${runningCount} running`}
      hints={detail
        ? [{ key: 'Esc', action: 'back' }]
        : [
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'view details' },
            { key: 'Esc', action: 'close' },
          ]}
    >
      {detail && selected ? (
        <TaskDetail task={selected} output={peekOutput(selected.id)} maxOutputLines={visibleCount} />
      ) : (
        <TaskList
          tasks={visibleTasks}
          selectedIndex={selectedIndex}
          windowStart={window.start}
          hasAbove={window.hasAbove}
          hasBelow={window.hasBelow}
        />
      )}
    </CommandPane>
  )
}

function TaskList({
  tasks,
  selectedIndex,
  windowStart,
  hasAbove,
  hasBelow,
}: {
  tasks: BackgroundTaskSnapshot[]
  selectedIndex: number
  windowStart: number
  hasAbove: boolean
  hasBelow: boolean
}) {
  if (tasks.length === 0) return <Box marginTop={1}><Text color={theme.dimText}>No background tasks.</Text></Box>
  return (
    <Box flexDirection="column">
      {tasks.map((task, index) => (
        <CommandListItem
          key={task.id}
          focused={windowStart + index === selectedIndex}
          showMoreAbove={index === 0 && hasAbove}
          showMoreBelow={index === tasks.length - 1 && hasBelow}
          description={task.command ?? task.description}
        >
          {pad(task.status, 9)} {pad(task.kind, 5)} {task.id.slice(0, 8)}
        </CommandListItem>
      ))}
    </Box>
  )
}

function TaskDetail({ task, output, maxOutputLines }: { task: BackgroundTaskSnapshot; output: string; maxOutputLines: number }) {
  const duration = (task.finishedAt ?? Date.now()) - task.startedAt
  const outputLines = output.split('\n')
  const visibleOutput = outputLines.slice(-maxOutputLines).join('\n')
  const omitted = Math.max(0, outputLines.length - maxOutputLines)
  return (
    <Box flexDirection="column">
      <Text>task: {task.id}</Text>
      <Text>kind: {task.kind}</Text>
      <Text>status: {task.status}</Text>
      {task.pid ? <Text>pid: {task.pid}</Text> : null}
      {task.agentId ? <Text>agent: {task.agentType} #{task.agentId.slice(0, 8)}</Text> : null}
      {task.command ? <Text>command: {task.command}</Text> : null}
      {task.description ? <Text>description: {task.description}</Text> : null}
      <Text>duration: {formatDuration(duration)}</Text>
      {task.exitCode !== undefined ? <Text>exit code: {String(task.exitCode)}</Text> : null}
      {task.signal ? <Text>signal: {task.signal}</Text> : null}
      {task.reason ? <Text color={theme.warning}>reason: {task.reason}</Text> : null}
      {task.kind === 'shell' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dimText}>Latest output{omitted > 0 ? ` · ${omitted} earlier lines hidden` : ''}</Text>
          <Text>{visibleOutput || '(no output)'}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function pad(value: string, width: number): string {
  const truncated = value.length > width ? `${value.slice(0, width - 1)}…` : value
  return truncated.padEnd(width)
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`
  return `${Math.floor(ms / 60_000)}m`
}
