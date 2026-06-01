import { z } from 'zod/v3'
import type { SessionRecord, TaskItem, Tool, ToolContext } from '../harness/types.js'

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
const taskUpdateStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

const todoItemSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1).describe('A concise description of the todo item'),
  status: todoStatusSchema,
  activeForm: z.string().min(1).describe('Present continuous form shown when in_progress'),
}).strict()

const taskCreateInputSchema = z.object({
  subject: z.string().min(1).describe('A brief title for the task'),
  description: z.string().min(1).describe('What needs to be done'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
}).strict()

const taskUpdateInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to update'),
  subject: z.string().min(1).optional().describe('New subject for the task'),
  description: z.string().min(1).optional().describe('New description for the task'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  status: taskUpdateStatusSchema.optional().describe('New status for the task'),
  owner: z.string().optional().describe('New owner for the task'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
}).strict()

type TodoItem = z.infer<typeof todoItemSchema>
type TaskCreateInput = z.infer<typeof taskCreateInputSchema>
type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>

const TASK_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

function normalizeTodoId(id: string | undefined, index: number): string {
  return id?.trim() || String(index + 1)
}

function taskFromTodo(todo: TodoItem, index: number): TaskItem {
  const id = normalizeTodoId(todo.id, index)
  return normalizeTask({
    id,
    status: todo.status,
    subject: todo.content,
    description: todo.content,
    activeForm: todo.activeForm,
  })
}

function normalizeTask(task: TaskItem): TaskItem {
  return {
    ...task,
    blocks: [...(task.blocks ?? [])],
    blockedBy: [...(task.blockedBy ?? [])],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

function ensureTaskState(context: ToolContext): Map<string, TaskItem> {
  if (!context.taskState) context.taskState = new Map()
  return context.taskState
}

function nextTaskId(tasks: ReadonlyMap<string, TaskItem>): string {
  const numericIds = [...tasks.keys()]
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  let index = numericIds.length > 0 ? Math.max(...numericIds) + 1 : tasks.size + 1
  while (tasks.has(String(index))) index++
  return String(index)
}

function sortedTasks(tasks: Iterable<TaskItem>): TaskItem[] {
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

function isRemainingTask(task: TaskItem): boolean {
  return task.status === 'pending' || task.status === 'in_progress'
}

function summarizeTaskState(tasks: readonly TaskItem[]): string {
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

function formatTaskLine(task: TaskItem, completedIds = new Set<string>()): string {
  const owner = task.owner ? ` (${task.owner})` : ''
  const openBlockers = (task.blockedBy ?? []).filter((id) => !completedIds.has(id))
  const blocked = openBlockers.length > 0 ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(', ')}]` : ''
  const active = task.status === 'in_progress' && task.activeForm ? ` - ${task.activeForm}` : ''
  return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}${active}`
}

function taskDisplay(tasks: readonly TaskItem[]) {
  const remaining = tasks.filter(isRemainingTask).length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    summary: compactTaskSummary(tasks, remaining, completed),
    detail: summarizeTaskState(tasks),
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

function applyTodoWrite(input: { todos: TodoItem[] }, tasks: Map<string, TaskItem>): { ok: true } | { ok: false; content: string } {
  const seen = new Set<string>()
  const next = new Map<string, TaskItem>()
  const allDone = input.todos.length > 0 && input.todos.every((todo) => todo.status === 'completed')

  if (!allDone) {
    for (const [index, todo] of input.todos.entries()) {
      const task = taskFromTodo(todo, index)
      if (seen.has(task.id)) {
        return { ok: false, content: `Duplicate todo id: ${task.id}` }
      }
      seen.add(task.id)
      next.set(task.id, task)
    }
  }

  tasks.clear()
  for (const [id, task] of next) tasks.set(id, task)
  return { ok: true }
}

function applyTaskCreate(input: TaskCreateInput, tasks: Map<string, TaskItem>): TaskItem {
  const id = nextTaskId(tasks)
  const task = normalizeTask({
    id,
    status: 'pending',
    subject: input.subject,
    description: input.description,
    ...(input.activeForm ? { activeForm: input.activeForm } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  })
  tasks.set(id, task)
  return task
}

function mergeMetadata(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!incoming) return existing
  const merged = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function addUniqueValues(current: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] | undefined {
  if (!incoming || incoming.length === 0) return current ? [...current] : undefined
  const next = new Set(current ?? [])
  for (const item of incoming) next.add(item)
  return [...next]
}

function deleteTask(tasks: Map<string, TaskItem>, taskId: string): boolean {
  const deleted = tasks.delete(taskId)
  if (!deleted) return false
  for (const [id, task] of tasks) {
    const blocks = (task.blocks ?? []).filter((candidate) => candidate !== taskId)
    const blockedBy = (task.blockedBy ?? []).filter((candidate) => candidate !== taskId)
    tasks.set(id, normalizeTask({ ...task, blocks, blockedBy }))
  }
  return true
}

function applyTaskUpdate(input: TaskUpdateInput, tasks: Map<string, TaskItem>): { found: boolean; deleted?: boolean; updated?: TaskItem } {
  const existing = tasks.get(input.taskId)
  if (!existing) return { found: false }

  if (input.status === 'deleted') {
    return { found: true, deleted: deleteTask(tasks, input.taskId) }
  }

  const updated = normalizeTask({
    ...existing,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    blocks: addUniqueValues(existing.blocks, input.addBlocks) ?? [],
    blockedBy: addUniqueValues(existing.blockedBy, input.addBlockedBy) ?? [],
    metadata: mergeMetadata(existing.metadata, input.metadata),
  })
  tasks.set(input.taskId, updated)

  for (const blockId of input.addBlocks ?? []) {
    const blocked = tasks.get(blockId)
    if (blocked) {
      tasks.set(blockId, normalizeTask({
        ...blocked,
        blockedBy: addUniqueValues(blocked.blockedBy, [input.taskId]) ?? [],
      }))
    }
  }
  for (const blockerId of input.addBlockedBy ?? []) {
    const blocker = tasks.get(blockerId)
    if (blocker) {
      tasks.set(blockerId, normalizeTask({
        ...blocker,
        blocks: addUniqueValues(blocker.blocks, [input.taskId]) ?? [],
      }))
    }
  }

  return { found: true, updated }
}

export function restoreTaskStateFromRecords(records: readonly SessionRecord[]): Map<string, TaskItem> {
  const tasks = new Map<string, TaskItem>()
  const toolUses = new Map<string, Extract<SessionRecord, { type: 'tool_use' }>>()

  for (const record of records) {
    if (record.type === 'tool_use' && TASK_TOOL_NAMES.has(record.tool)) {
      toolUses.set(record.id, record)
      continue
    }

    if (record.type !== 'tool_result' || !record.ok) continue
    const toolUse = toolUses.get(record.toolUseId)
    if (!toolUse) continue

    try {
      if (toolUse.tool === 'TodoWrite') {
        const parsed = z.object({ todos: z.array(todoItemSchema) }).strict().parse(toolUse.input)
        applyTodoWrite(parsed, tasks)
      } else if (toolUse.tool === 'TaskCreate') {
        applyTaskCreate(taskCreateInputSchema.parse(toolUse.input), tasks)
      } else if (toolUse.tool === 'TaskUpdate') {
        applyTaskUpdate(taskUpdateInputSchema.parse(toolUse.input), tasks)
      }
    } catch {
      // Ignore stale or malformed historical task calls; live execution already validates inputs.
    }
  }

  return tasks
}

export const todoWriteTool: Tool = {
  name: 'TodoWrite',
  description: 'Update the todo list for the current session. Use proactively to track progress and pending tasks; include content, status, and activeForm for each item.',
  inputSchema: z.object({
    todos: z.array(todoItemSchema).describe('The complete updated todo list for the current session.'),
  }).strict(),
  riskLevel: 'safe',
  userFacingName: () => 'Todo',
  getToolUseSummary(input) {
    const todos = typeof input === 'object' && input !== null
      ? (input as { todos?: unknown }).todos
      : undefined
    if (!Array.isArray(todos)) return null
    return `${todos.length} ${todos.length === 1 ? 'item' : 'items'}`
  },
  getActivityDescription(input) {
    const todos = typeof input === 'object' && input !== null
      ? (input as { todos?: unknown }).todos
      : undefined
    if (!Array.isArray(todos)) return 'Updating todo list'
    const active = todos.find((todo): todo is { status: string; activeForm: string } =>
      typeof todo === 'object'
      && todo !== null
      && (todo as { status?: unknown }).status === 'in_progress'
      && typeof (todo as { activeForm?: unknown }).activeForm === 'string'
      && (todo as { activeForm: string }).activeForm.trim().length > 0
    )
    return active?.activeForm ?? 'Updating todo list'
  },
  shouldDisplayResult: () => true,
  async execute(input, context: ToolContext) {
    const parsed = z.object({ todos: z.array(todoItemSchema) }).strict().parse(input)
    const tasks = ensureTaskState(context)
    const applied = applyTodoWrite(parsed, tasks)
    if (!applied.ok) return { ok: false, content: applied.content, errorCode: 'invalid_input' }

    const values = sortedTasks(tasks.values())
    return {
      ok: true,
      content: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
      metadata: { display: taskDisplay(values) },
    }
  },
}

export const taskCreateTool: Tool = {
  name: 'TaskCreate',
  description: 'Create a task in the session task list.',
  inputSchema: taskCreateInputSchema,
  riskLevel: 'safe',
  userFacingName: () => 'TaskCreate',
  getToolUseSummary(input) {
    return typeof input === 'object' && input !== null && typeof (input as { subject?: unknown }).subject === 'string'
      ? (input as { subject: string }).subject
      : null
  },
  getActivityDescription(input) {
    return typeof input === 'object' && input !== null && typeof (input as { activeForm?: unknown }).activeForm === 'string'
      ? (input as { activeForm: string }).activeForm
      : 'Creating task'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskCreateInputSchema.parse(input)
    const tasks = ensureTaskState(context)
    const task = applyTaskCreate(parsed, tasks)
    return {
      ok: true,
      content: `Task #${task.id} created successfully: ${task.subject}`,
      metadata: { display: taskDisplay(sortedTasks(tasks.values())) },
    }
  },
}

export const taskListTool: Tool = {
  name: 'TaskList',
  description: 'List all tasks in the session task list, grouped by remaining and completed work.',
  inputSchema: z.object({}).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  userFacingName: () => 'TaskList',
  getToolUseSummary: () => null,
  getActivityDescription: () => 'Listing tasks',
  shouldDisplayResult: () => true,
  async execute(_input, context) {
    const values = sortedTasks(ensureTaskState(context).values())
    return {
      ok: true,
      content: summarizeTaskState(values),
      metadata: { display: taskDisplay(values) },
    }
  },
}

export const taskGetTool: Tool = {
  name: 'TaskGet',
  description: 'Retrieve a task by ID.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to retrieve'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  userFacingName: () => 'TaskGet',
  getToolUseSummary(input) {
    return typeof input === 'object' && input !== null && typeof (input as { taskId?: unknown }).taskId === 'string'
      ? `#${(input as { taskId: string }).taskId}`
      : null
  },
  getActivityDescription: () => 'Reading task',
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskGetTool.inputSchema.parse(input) as { taskId: string }
    const task = ensureTaskState(context).get(parsed.taskId)
    if (!task) {
      return { ok: true, content: 'Task not found', metadata: { display: { summary: 'Task not found' } } }
    }
    const content = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
      ...(task.activeForm ? [`Active form: ${task.activeForm}`] : []),
      ...(task.owner ? [`Owner: ${task.owner}`] : []),
      ...(task.blockedBy && task.blockedBy.length > 0 ? [`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(', ')}`] : []),
      ...(task.blocks && task.blocks.length > 0 ? [`Blocks: ${task.blocks.map((id) => `#${id}`).join(', ')}`] : []),
    ].join('\n')
    return { ok: true, content, metadata: { display: { summary: formatTaskLine(task), detail: content } } }
  },
}

export const taskUpdateTool: Tool = {
  name: 'TaskUpdate',
  description: 'Update a task in the session task list.',
  inputSchema: taskUpdateInputSchema,
  riskLevel: 'safe',
  userFacingName: () => 'TaskUpdate',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const value = input as { taskId?: unknown; status?: unknown; subject?: unknown }
    const parts = [
      typeof value.taskId === 'string' ? `#${value.taskId}` : undefined,
      typeof value.status === 'string' ? value.status : undefined,
      typeof value.subject === 'string' ? value.subject : undefined,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' ')
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Updating task'
    const value = input as { activeForm?: unknown; status?: unknown; subject?: unknown }
    if (value.status === 'in_progress' && typeof value.activeForm === 'string') return value.activeForm
    if (value.status === 'in_progress' && typeof value.subject === 'string') return value.subject
    return 'Updating task'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskUpdateInputSchema.parse(input)
    const tasks = ensureTaskState(context)
    const result = applyTaskUpdate(parsed, tasks)
    if (!result.found) {
      return {
        ok: true,
        content: 'Task not found',
        metadata: { display: { summary: 'Task not found' } },
      }
    }
    if (result.deleted) {
      return {
        ok: true,
        content: `Updated task #${parsed.taskId} deleted`,
        metadata: { display: taskDisplay(sortedTasks(tasks.values())) },
      }
    }

    const fields = [
      parsed.subject !== undefined ? 'subject' : undefined,
      parsed.description !== undefined ? 'description' : undefined,
      parsed.activeForm !== undefined ? 'activeForm' : undefined,
      parsed.status !== undefined ? 'status' : undefined,
      parsed.owner !== undefined ? 'owner' : undefined,
      parsed.addBlocks && parsed.addBlocks.length > 0 ? 'blocks' : undefined,
      parsed.addBlockedBy && parsed.addBlockedBy.length > 0 ? 'blockedBy' : undefined,
      parsed.metadata !== undefined ? 'metadata' : undefined,
    ].filter((field): field is string => Boolean(field))

    return {
      ok: true,
      content: `Updated task #${parsed.taskId} ${fields.join(', ') || 'no changes'}`,
      metadata: { display: taskDisplay(sortedTasks(tasks.values())) },
    }
  },
}
