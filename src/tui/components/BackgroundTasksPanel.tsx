import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import { theme } from '../theme.js'

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
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
      paddingX={1}
    >
      <Text bold color={theme.brand}>Background tasks</Text>
      {detail && selected ? (
        <TaskDetail task={selected} output={peekOutput(selected.id)} />
      ) : (
        <TaskList tasks={sorted} selectedIndex={selectedIndex} />
      )}
      <Box marginTop={1}>
        <Text color={theme.dimText}>{detail ? 'Esc to return' : 'Enter for details  Esc to close'}</Text>
      </Box>
    </Box>
  )
}

function TaskList({ tasks, selectedIndex }: { tasks: BackgroundTaskSnapshot[]; selectedIndex: number }) {
  if (tasks.length === 0) return <Box marginTop={1}><Text color={theme.dimText}>No background tasks.</Text></Box>
  return (
    <Box flexDirection="column" marginTop={1}>
      {tasks.map((task, index) => (
        <Text key={task.id} color={index === selectedIndex ? theme.brand : undefined}>
          {index === selectedIndex ? '❯' : ' '} {pad(task.status, 9)} {pad(task.kind, 5)} {pad(task.id, 10)} {task.command ?? task.description ?? ''}
        </Text>
      ))}
    </Box>
  )
}

function TaskDetail({ task, output }: { task: BackgroundTaskSnapshot; output: string }) {
  const duration = (task.finishedAt ?? Date.now()) - task.startedAt
  return (
    <Box flexDirection="column" marginTop={1}>
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
          <Text color={theme.dimText}>latest output (non-consuming):</Text>
          <Text>{output || '(no output)'}</Text>
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
