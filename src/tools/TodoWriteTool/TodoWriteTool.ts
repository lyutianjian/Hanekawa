import type { Tool, ToolContext } from '../../harness/types.js'
import { sortedTasks, taskDisplay } from '../taskFormat.js'
import { applyTodoWrite, ensureTaskState } from '../taskState.js'
import { todoWriteInputSchema } from '../taskSchemas.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'

export const todoWriteTool: Tool = {
  name: TODO_WRITE_TOOL_NAME,
  description: 'Update the todo list for the current session. Compatibility path for lightweight todo tracking; prefer TaskCreate, TaskList, TaskGet, and TaskUpdate for structured multi-step task tracking.',
  inputSchema: todoWriteInputSchema,
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
    const parsed = todoWriteInputSchema.parse(input)
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
