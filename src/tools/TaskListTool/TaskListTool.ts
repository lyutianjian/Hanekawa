import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { sortedTasks, summarizeTaskState, taskDisplay } from '../taskFormat.js'
import { ensureTaskState } from '../taskState.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

export const taskListTool: Tool = {
  name: TASK_LIST_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${getPrompt()}`,
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
