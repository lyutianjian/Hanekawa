import { z } from 'zod/v3'
import type { TaskItem, Tool, ToolContext } from '../harness/types.js'

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
const taskUpdateStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

const todoItemSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1).describe('A concise description of the todo item'),
  status: todoStatusSchema,
  activeForm: z.string().min(1).describe('Present continuous form shown when in_progress').optional(),
}).strict()

function normalizeTodoId(id: string | undefined, index: number): string {
  return id?.trim() || String(index + 1)
}

function taskFromTodo(todo: z.infer<typeof todoItemSchema>, index: number): TaskItem {
  const id = normalizeTodoId(todo.id, index)
  return {
    id,
    status: todo.status,
    subject: todo.content,
    description: todo.content,
    activeForm: todo.activeForm,
  }
}

function formatTodos(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return 'Todo list is now empty.'
  return tasks.map((task) => `[${task.id}] ${task.status}: ${task.subject}`).join('\n')
}

function ensureTaskState(context: ToolContext): Map<string, TaskItem> {
  if (!context.taskState) context.taskState = new Map()
  return context.taskState
}

function nextTaskId(tasks: ReadonlyMap<string, TaskItem>): string {
  let index = tasks.size + 1
  while (tasks.has(String(index))) index++
  return String(index)
}

function summarizeTaskState(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return 'No tasks found'
  const remaining = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress')
  const completed = tasks.filter((task) => task.status === 'completed')
  const sections: string[] = []
  if (remaining.length > 0) {
    sections.push([
      `Remaining tasks (${remaining.length}):`,
      ...remaining.map(formatTaskLine),
    ].join('\n'))
  }
  if (completed.length > 0) {
    sections.push([
      `Completed tasks (${completed.length}):`,
      ...completed.map(formatTaskLine),
    ].join('\n'))
  }
  return sections.join('\n\n')
}

function formatTaskLine(task: TaskItem): string {
  const active = task.status === 'in_progress' && task.activeForm ? ` - ${task.activeForm}` : ''
  return `#${task.id} [${task.status}] ${task.subject}${active}`
}

function taskDisplay(tasks: readonly TaskItem[]) {
  const remaining = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    summary: `${remaining} remaining, ${completed} completed`,
    detail: summarizeTaskState(tasks),
  }
}

export const todoWriteTool: Tool = {
  name: 'TodoWrite',
  description: 'Replace the session todo list with a complete updated list.',
  inputSchema: z.object({
    todos: z.array(todoItemSchema).describe('The complete todo list for the current session. Omit finished items only if they should no longer be tracked.'),
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
  getActivityDescription: () => 'Updating todo list',
  shouldDisplayResult: () => true,
  async execute(input, context: ToolContext) {
    const parsed = z.object({ todos: z.array(todoItemSchema) }).strict().parse(input)
    const seen = new Set<string>()
    const tasks = new Map<string, TaskItem>()

    for (const [index, todo] of parsed.todos.entries()) {
      const task = taskFromTodo(todo, index)
      if (seen.has(task.id)) {
        return { ok: false, content: `Duplicate todo id: ${task.id}`, errorCode: 'invalid_input' }
      }
      seen.add(task.id)
      tasks.set(task.id, task)
    }

    context.taskState = tasks
    const values = [...tasks.values()]
    return {
      ok: true,
      content: formatTodos(values),
      metadata: { display: taskDisplay(values) },
    }
  },
}

export const taskCreateTool: Tool = {
  name: 'TaskCreate',
  description: 'Create a task in the session task list.',
  inputSchema: z.object({
    subject: z.string().min(1).describe('A brief title for the task'),
    description: z.string().min(1).describe('What needs to be done'),
    activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
  }).strict(),
  riskLevel: 'safe',
  userFacingName: () => 'TaskCreate',
  getToolUseSummary(input) {
    return typeof input === 'object' && input !== null && typeof (input as { subject?: unknown }).subject === 'string'
      ? (input as { subject: string }).subject
      : null
  },
  getActivityDescription: () => 'Creating task',
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskCreateTool.inputSchema.parse(input) as {
      subject: string
      description: string
      activeForm?: string
    }
    const tasks = ensureTaskState(context)
    const id = nextTaskId(tasks)
    const task: TaskItem = {
      id,
      status: 'pending',
      subject: parsed.subject,
      description: parsed.description,
      ...(parsed.activeForm ? { activeForm: parsed.activeForm } : {}),
    }
    tasks.set(id, task)
    return {
      ok: true,
      content: `Task #${id} created successfully: ${task.subject}`,
      metadata: { display: taskDisplay([...tasks.values()]) },
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
    const values = [...ensureTaskState(context).values()]
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
    ].join('\n')
    return { ok: true, content, metadata: { display: { summary: formatTaskLine(task), detail: content } } }
  },
}

export const taskUpdateTool: Tool = {
  name: 'TaskUpdate',
  description: 'Update a task in the session task list.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to update'),
    subject: z.string().min(1).optional().describe('New subject for the task'),
    description: z.string().min(1).optional().describe('New description for the task'),
    activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
    status: taskUpdateStatusSchema.optional().describe('New status for the task'),
    owner: z.string().optional().describe('Accepted for Claude Code compatibility; ignored by Hanekawa task state'),
    addBlocks: z.array(z.string()).optional().describe('Accepted for Claude Code compatibility; ignored by Hanekawa task state'),
    addBlockedBy: z.array(z.string()).optional().describe('Accepted for Claude Code compatibility; ignored by Hanekawa task state'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Accepted for Claude Code compatibility; ignored by Hanekawa task state'),
  }).strict(),
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
  getActivityDescription: () => 'Updating task',
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskUpdateTool.inputSchema.parse(input) as {
      taskId: string
      subject?: string
      description?: string
      activeForm?: string
      status?: TaskItem['status']
    }
    const tasks = ensureTaskState(context)
    const existing = tasks.get(parsed.taskId)
    if (!existing) {
      return {
        ok: true,
        content: 'Task not found',
        metadata: { display: { summary: 'Task not found' } },
      }
    }
    if (parsed.status === 'deleted') {
      tasks.delete(parsed.taskId)
      return {
        ok: true,
        content: `Task #${parsed.taskId} deleted`,
        metadata: { display: taskDisplay([...tasks.values()]) },
      }
    }

    const updated: TaskItem = {
      ...existing,
      ...(parsed.subject ? { subject: parsed.subject } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.activeForm ? { activeForm: parsed.activeForm } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
    }
    tasks.set(parsed.taskId, updated)
    return {
      ok: true,
      content: `Task #${parsed.taskId} updated: ${formatTaskLine(updated)}`,
      metadata: { display: taskDisplay([...tasks.values()]) },
    }
  },
}
