import type { Tool } from '../../harness/types.js'
import { sortedTasks, taskDisplay } from '../taskFormat.js'
import { applyTaskUpdate, ensureTaskState } from '../taskState.js'
import { taskUpdateInputSchema } from '../taskSchemas.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

export const taskUpdateTool: Tool = {
  name: TASK_UPDATE_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${PROMPT}`,
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
