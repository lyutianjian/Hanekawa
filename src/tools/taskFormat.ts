import type { TaskDisplayCounts, TaskDisplayItem, TaskDisplaySnapshot, TaskItem, ToolResultDisplay } from '../harness/types.js'

export function sortedTasks(tasks: Iterable<TaskItem>): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const aNum = Number.parseInt(a.id, 10)
    const bNum = Number.parseInt(b.id, 10)
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum
    return a.id.localeCompare(b.id)
  })
}

export function remainingTasksFromState(tasks: ReadonlyMap<string, TaskItem> | undefined): TaskItem[] {
  return sortedTasks(tasks?.values() ?? []).filter(isRemainingTask).map(normalizeTask)
}

export function isRemainingTask(task: TaskItem): boolean {
  return task.status === 'pending' || task.status === 'in_progress'
}

export function normalizeTask(task: TaskItem): TaskItem {
  return {
    ...task,
    blocks: [...(task.blocks ?? [])],
    blockedBy: [...(task.blockedBy ?? [])],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

export function summarizeTaskState(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return 'No tasks found'
  const completedIds = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  const remaining = tasks.filter(isRemainingTask)
  const completed = tasks.filter((task) => task.status === 'completed')
  const sections: string[] = []
  if (remaining.length > 0) {
    sections.push([
      `Remaining tasks (${remaining.length}):`,
      ...remaining.map((task) => formatTaskLine(task, completedIds)),
    ].join('\n'))
  }
  if (completed.length > 0) {
    sections.push([
      `Completed tasks (${completed.length}):`,
      ...completed.map((task) => formatTaskLine(task, completedIds)),
    ].join('\n'))
  }
  return sections.join('\n\n')
}

export function formatTaskLine(task: TaskItem, completedIds = new Set<string>()): string {
  const owner = task.owner ? ` (${task.owner})` : ''
  const openBlockers = (task.blockedBy ?? []).filter((id) => !completedIds.has(id))
  const blocked = openBlockers.length > 0 ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(', ')}]` : ''
  const active = task.status === 'in_progress' && task.activeForm ? ` - ${task.activeForm}` : ''
  return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}${active}`
}

export function taskDisplay(tasks: readonly TaskItem[]): ToolResultDisplay {
  const remaining = tasks.filter(isRemainingTask).length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    summary: compactTaskSummary(tasks, remaining, completed),
    detail: summarizeTaskState(tasks),
    taskSnapshot: createTaskSnapshot(tasks),
  }
}

export function createTaskSnapshot(tasks: readonly TaskItem[]): TaskDisplaySnapshot {
  const normalized = sortedTasks(tasks).map(toTaskDisplayItem)
  const counts = countTaskDisplayItems(normalized)
  const activeTask = normalized.find((task) => task.status === 'in_progress')
  return {
    tasks: normalized,
    counts,
    ...(activeTask ? { activeTaskId: activeTask.id } : {}),
  }
}

function toTaskDisplayItem(task: TaskItem): TaskDisplayItem {
  return {
    id: task.id,
    status: task.status,
    subject: task.subject,
    description: task.description,
    ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    ...(task.owner ? { owner: task.owner } : {}),
    blocks: [...(task.blocks ?? [])],
    blockedBy: [...(task.blockedBy ?? [])],
  }
}

function countTaskDisplayItems(tasks: readonly TaskDisplayItem[]): TaskDisplayCounts {
  const pending = tasks.filter((task) => task.status === 'pending').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    total: tasks.length,
    remaining: pending + inProgress,
    pending,
    inProgress,
    completed,
  }
}

function compactTaskSummary(tasks: readonly TaskItem[], remaining: number, completed: number): string {
  if (tasks.length === 0) return '0 remaining, 0 completed'

  const inProgress = tasks.filter((task) => task.status === 'in_progress')
  const pending = tasks.filter((task) => task.status === 'pending')
  const completedTasks = tasks.filter((task) => task.status === 'completed')
  const visible: TaskItem[] = []

  for (const task of inProgress) {
    if (visible.length >= 3) break
    visible.push(task)
  }
  for (const task of pending) {
    if (visible.length >= 3) break
    visible.push(task)
  }
  if (visible.length < 3) {
    for (const task of completedTasks.slice(-1)) {
      if (visible.length >= 3) break
      visible.push(task)
    }
  }

  const visibleIds = new Set(visible.map((task) => task.id))
  const hiddenPending = pending.filter((task) => !visibleIds.has(task.id)).length
  const hiddenCompleted = completedTasks.filter((task) => !visibleIds.has(task.id)).length
  const compact = [
    ...visible.map((task) => formatCompactTaskLine(task)),
    hiddenPending > 0 ? `+${hiddenPending} pending` : undefined,
    hiddenCompleted > 0 ? `+${hiddenCompleted} completed` : undefined,
  ].filter((part): part is string => Boolean(part))

  return compact.length > 0
    ? `${remaining} remaining, ${completed} completed - ${compact.join('; ')}`
    : `${remaining} remaining, ${completed} completed`
}

function formatCompactTaskLine(task: TaskItem): string {
  const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
  return `#${task.id} [${task.status}] ${label}`
}
