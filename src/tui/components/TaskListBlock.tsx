import figures from 'figures'
import stringWidth from 'string-width'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { TaskDisplayItem, TaskDisplaySnapshot } from '../../harness/types.js'
import { theme } from '../theme.js'

interface TaskListBlockProps {
  snapshot: TaskDisplaySnapshot
  showHeader?: boolean
  runningColor?: string
}

const DEFAULT_MAX_TASKS = 10
const RECENT_COMPLETED_TTL_MS = 30_000
const CHECK_MARK = '✔'
const RUNNING_MARK = '■'
const OPEN_MARK = '□'

export function TaskListBlock({ snapshot, showHeader = true, runningColor = theme.spinner }: TaskListBlockProps) {
  const { stdout } = useStdout()
  const terminalRows = stdout.rows || 24
  const terminalWidth = stdout.columns || 80
  const maxTasks = terminalRows <= 10
    ? 0
    : Math.min(DEFAULT_MAX_TASKS, Math.max(3, terminalRows - 14))
  const [, forceUpdate] = useState(0)
  const completionTimestampsRef = useRef(new Map<string, number>())
  const previousCompletedIdsRef = useRef<Set<string> | null>(null)
  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  }

  const currentCompletedIds = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  const now = Date.now()
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) completionTimestampsRef.current.set(id, now)
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) completionTimestampsRef.current.delete(id)
  }
  previousCompletedIdsRef.current = currentCompletedIds

  useEffect(() => {
    if (completionTimestampsRef.current.size === 0) return

    const currentNow = Date.now()
    let earliestExpiry = Infinity
    for (const timestamp of completionTimestampsRef.current.values()) {
      const expiry = timestamp + RECENT_COMPLETED_TTL_MS
      if (expiry > currentNow && expiry < earliestExpiry) earliestExpiry = expiry
    }
    if (earliestExpiry === Infinity) return

    const timer = setTimeout(() => forceUpdate((value) => value + 1), earliestExpiry - currentNow)
    return () => clearTimeout(timer)
  }, [snapshot.tasks])

  const visibleTasks = selectVisibleTasks(snapshot.tasks, maxTasks, completionTimestampsRef.current, now)
  const hiddenCount = visibleTasks.hiddenTasks.length
  const hiddenSummary = formatHiddenTaskSummary(visibleTasks.hiddenTasks)
  const completedIds = new Set(snapshot.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  const textWidth = Math.max(16, terminalWidth - 6)

  if (visibleTasks.tasks.length === 0) {
    return (
      <Box flexDirection="column">
        {showHeader && <TaskListHeader snapshot={snapshot} />}
        <Box paddingLeft={2}>
          <Text color={theme.dimText} dimColor>
            {snapshot.counts.total === 0 ? 'No tasks' : `${snapshot.counts.total} tasks hidden`}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {showHeader && <TaskListHeader snapshot={snapshot} />}
      {visibleTasks.tasks.map((task) => (
        <TaskListRow
          key={task.id}
          task={task}
          completedIds={completedIds}
          textWidth={textWidth}
          runningColor={runningColor}
        />
      ))}
      {hiddenCount > 0 && (
        <Box paddingLeft={2}>
          <Text color={theme.dimText} dimColor>
            {hiddenSummary}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function TaskListHeader({ snapshot }: { snapshot: TaskDisplaySnapshot }) {
  return (
    <Box>
      <Text color={theme.dimText} bold>
        {snapshot.counts.total} {snapshot.counts.total === 1 ? 'task' : 'tasks'}
      </Text>
      <Text color={theme.dimText}>
        {` (${snapshot.counts.completed} done, ${snapshot.counts.inProgress} in progress, ${snapshot.counts.pending} open)`}
      </Text>
    </Box>
  )
}

function TaskListRow({
  task,
  completedIds,
  textWidth,
  runningColor,
}: {
  task: TaskDisplayItem
  completedIds: ReadonlySet<string>
  textWidth: number
  runningColor: string
}) {
  const openBlockers = task.blockedBy.filter((id) => !completedIds.has(id))
  const blocked = task.status !== 'completed' && openBlockers.length > 0
  const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
  const suffix = blocked ? ` ${figures.pointerSmall} blocked by ${openBlockers.map((id) => `#${id}`).join(', ')}` : ''
  const availableLabelWidth = Math.max(1, textWidth - stringWidth(suffix))
  const visual = getTaskVisual(task, blocked, runningColor)

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box width={2} flexShrink={0}>
        <Text color={visual.iconColor} dimColor={visual.dim}>
          {visual.icon}
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text
          color={visual.textColor}
          dimColor={visual.dim}
          bold={visual.bold}
          strikethrough={visual.strikethrough}
        >
          {truncateEndByWidth(label, availableLabelWidth)}
        </Text>
        {suffix && (
          <Text color={theme.dimText} dimColor>
            {suffix}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export function getTaskVisual(task: TaskDisplayItem, blocked: boolean, runningColor: string = theme.spinner): {
  icon: string
  iconColor: string
  textColor: string
  bold: boolean
  dim: boolean
  strikethrough: boolean
} {
  if (task.status === 'completed') {
    return {
      icon: CHECK_MARK,
      iconColor: theme.codeInline,
      textColor: theme.dimText,
      bold: false,
      dim: true,
      strikethrough: true,
    }
  }

  if (task.status === 'in_progress') {
    return {
      icon: RUNNING_MARK,
      iconColor: runningColor,
      textColor: theme.assistantText,
      bold: true,
      dim: false,
      strikethrough: false,
    }
  }

  return {
    icon: OPEN_MARK,
    iconColor: blocked ? theme.dimText : theme.assistantText,
    textColor: blocked ? theme.dimText : theme.assistantText,
    bold: false,
    dim: blocked,
    strikethrough: false,
  }
}

function selectVisibleTasks(
  tasks: readonly TaskDisplayItem[],
  maxTasks: number,
  completionTimestamps: ReadonlyMap<string, number>,
  now: number,
): { tasks: TaskDisplayItem[]; hiddenTasks: TaskDisplayItem[] } {
  const displayable = tasks.filter((task) => task.status !== 'deleted')
  if (maxTasks <= 0) return { tasks: [], hiddenTasks: displayable }
  if (displayable.length <= maxTasks) return { tasks: [...displayable].sort(byIdAsc), hiddenTasks: [] }

  const recentCompleted: TaskDisplayItem[] = []
  const olderCompleted: TaskDisplayItem[] = []
  for (const task of displayable.filter((candidate) => candidate.status === 'completed')) {
    const completedAt = completionTimestamps.get(task.id)
    if (completedAt && now - completedAt < RECENT_COMPLETED_TTL_MS) {
      recentCompleted.push(task)
    } else {
      olderCompleted.push(task)
    }
  }

  const unresolvedTaskIds = new Set(displayable.filter((task) => task.status !== 'completed').map((task) => task.id))
  const inProgress = displayable.filter((task) => task.status === 'in_progress').sort(byIdAsc)
  const pending = displayable.filter((task) => task.status === 'pending').sort((a, b) => {
    const aBlocked = a.blockedBy.some((id) => unresolvedTaskIds.has(id))
    const bBlocked = b.blockedBy.some((id) => unresolvedTaskIds.has(id))
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
    return byIdAsc(a, b)
  })
  const prioritized = [
    ...recentCompleted.sort(byIdAsc),
    ...inProgress,
    ...pending,
    ...olderCompleted.sort(byIdAsc),
  ]

  return {
    tasks: prioritized.slice(0, maxTasks),
    hiddenTasks: prioritized.slice(maxTasks),
  }
}

function byIdAsc(a: TaskDisplayItem, b: TaskDisplayItem): number {
  const aNum = Number.parseInt(a.id, 10)
  const bNum = Number.parseInt(b.id, 10)
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum
  return a.id.localeCompare(b.id)
}

function formatHiddenTaskSummary(tasks: readonly TaskDisplayItem[]): string {
  if (tasks.length === 0) return ''

  const parts: string[] = []
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const pending = tasks.filter((task) => task.status === 'pending').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  if (inProgress > 0) parts.push(`${inProgress} in progress`)
  if (pending > 0) parts.push(`${pending} pending`)
  if (completed > 0) parts.push(`${completed} completed`)
  return `${figures.ellipsis} +${parts.join(', ')}`
}

function truncateEndByWidth(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value
  const ellipsis = '...'
  const target = Math.max(1, maxWidth - stringWidth(ellipsis))
  let output = ''
  let width = 0
  for (const segment of [...value]) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > target) break
    output += segment
    width += segmentWidth
  }
  return `${output}${ellipsis}`
}
