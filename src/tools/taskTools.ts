import { z } from 'zod/v3'
import type { TaskItem, Tool, ToolContext } from '../harness/types.js'

const taskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

function getTasks(context: ToolContext): Map<string, TaskItem> {
  if (!context.taskState) {
    context.taskState = new Map()
  }
  return context.taskState
}

function nextTaskId(tasks: Map<string, TaskItem>): string {
  let maxId = 0
  for (const id of tasks.keys()) {
    const num = parseInt(id, 10)
    if (Number.isFinite(num) && num > maxId) maxId = num
  }
  return String(maxId + 1)
}

export const taskCreateTool: Tool = {
  name: 'TaskCreate',
  description: 'Create a structured task for the current coding session.',
  inputSchema: z.object({
    subject: z.string().min(1).describe('A brief title for the task'),
    description: z.string().min(1).describe('What needs to be done'),
    activeForm: z.string().min(1).describe('Present continuous form shown when in_progress').optional(),
    metadata: z.record(z.unknown()).describe('Arbitrary metadata to attach').optional(),
  }).strict(),
  riskLevel: 'safe',
  async execute(input, context) {
    const { subject, description, activeForm, metadata } = input as {
      subject: string
      description: string
      activeForm?: string
      metadata?: Record<string, unknown>
    }
    const tasks = getTasks(context)
    const id = nextTaskId(tasks)
    const task: TaskItem = {
      id,
      status: 'pending',
      subject,
      description,
      activeForm,
      metadata,
      blockedBy: [],
      blocks: [],
    }
    tasks.set(id, task)
    return { ok: true, content: `Task created: [${id}] ${subject}` }
  },
}

export const taskUpdateTool: Tool = {
  name: 'TaskUpdate',
  description: 'Update a task in the task list.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to update'),
    status: taskStatusSchema.optional(),
    subject: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    activeForm: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    addBlockedBy: z.array(z.string().min(1)).optional(),
    addBlocks: z.array(z.string().min(1)).optional(),
  }).strict(),
  riskLevel: 'safe',
  async execute(input, context) {
    const { taskId, status, subject, description, activeForm, metadata, addBlockedBy, addBlocks } = input as {
      taskId: string
      status?: TaskItem['status']
      subject?: string
      description?: string
      activeForm?: string
      metadata?: Record<string, unknown>
      addBlockedBy?: string[]
      addBlocks?: string[]
    }
    const tasks = getTasks(context)
    const task = tasks.get(taskId)
    if (!task) {
      return { ok: false, content: `Task not found: ${taskId}` }
    }
    if (status) task.status = status
    if (subject !== undefined) task.subject = subject
    if (description !== undefined) task.description = description
    if (activeForm !== undefined) task.activeForm = activeForm
    if (metadata !== undefined) {
      if (metadata === null) {
        task.metadata = undefined
      } else {
        task.metadata = { ...task.metadata, ...metadata }
        for (const key of Object.keys(metadata)) {
          if (metadata[key] === null) delete task.metadata[key]
        }
      }
    }
    if (addBlockedBy) {
      for (const id of addBlockedBy) {
        if (!task.blockedBy.includes(id)) task.blockedBy.push(id)
      }
    }
    if (addBlocks) {
      for (const id of addBlocks) {
        if (!task.blocks.includes(id)) task.blocks.push(id)
      }
    }
    return { ok: true, content: `Task updated: [${taskId}] ${task.subject}` }
  },
}

export const taskListTool: Tool = {
  name: 'TaskList',
  description: 'List all tasks in the current session.',
  inputSchema: z.object({
    status: taskStatusSchema.optional(),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  async execute(input, context) {
    const { status: filterStatus } = (input ?? {}) as { status?: string }
    const tasks = getTasks(context)
    const entries = [...tasks.values()]
      .filter((task) => task.status !== 'deleted')
      .filter((task) => !filterStatus || task.status === filterStatus)
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10))

    if (entries.length === 0) {
      return { ok: true, content: 'No tasks.' }
    }

    const lines = entries.map((task) => {
      const blocked = task.blockedBy.length > 0 ? ` [blocked by: ${task.blockedBy.join(', ')}]` : ''
      return `[${task.id}] ${task.status}: ${task.subject}${blocked}`
    })

    return { ok: true, content: lines.join('\n') }
  },
}

export const taskGetTool: Tool = {
  name: 'TaskGet',
  description: 'Get a specific task by ID.',
  inputSchema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to retrieve'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  async execute(input, context) {
    const { taskId } = input as { taskId: string }
    const tasks = getTasks(context)
    const task = tasks.get(taskId)
    if (!task) {
      return { ok: false, content: `Task not found: ${taskId}` }
    }

    const lines = [
      `Task: ${task.subject}`,
      `ID: ${task.id}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ]
    if (task.activeForm) lines.push(`Active form: ${task.activeForm}`)
    if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(', ')}`)
    if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.join(', ')}`)

    return { ok: true, content: lines.join('\n') }
  },
}
