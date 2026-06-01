import type { Tool } from '../../harness/types.js'
import { sortedTasks, taskDisplay } from '../taskFormat.js'
import { applyTaskCreate, ensureTaskState } from '../taskState.js'
import { taskCreateInputSchema } from '../taskSchemas.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

export const taskCreateTool: Tool = {
  name: TASK_CREATE_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${getPrompt()}`,
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
