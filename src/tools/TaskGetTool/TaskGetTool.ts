import type { Tool } from '../../harness/types.js'
import { formatTaskLine } from '../taskFormat.js'
import { ensureTaskState } from '../taskState.js'
import { taskGetInputSchema } from '../taskSchemas.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

export const taskGetTool: Tool = {
  name: TASK_GET_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${PROMPT}`,
  inputSchema: taskGetInputSchema,
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
    const parsed = taskGetInputSchema.parse(input)
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
