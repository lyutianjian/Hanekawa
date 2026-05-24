import { z } from 'zod/v3'
import type { TaskItem, Tool, ToolContext } from '../harness/types.js'

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

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

export const todoWriteTool: Tool = {
  name: 'TodoWrite',
  description: 'Replace the session todo list with a complete updated list.',
  inputSchema: z.object({
    todos: z.array(todoItemSchema).describe('The complete todo list for the current session. Omit finished items only if they should no longer be tracked.'),
  }).strict(),
  riskLevel: 'safe',
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
    return { ok: true, content: formatTodos([...tasks.values()]) }
  },
}
