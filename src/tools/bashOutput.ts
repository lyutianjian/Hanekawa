import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
} from '../services/backgroundTasks/registry.js'

interface BashOutputInput {
  task_id: string
  filter?: string
  wait_ms?: number
}

export function createBashOutputTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
    name: 'BashOutput',
    description: 'Read new output from a background Bash task. Each read advances that task\'s output cursor.',
    searchHint: 'read background shell logs output',
    inputSchema: z.object({
      task_id: z.string().min(1),
      filter: z.string().max(1_000).optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
    }).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 100_000,
    userFacingName: () => 'BashOutput',
    async execute(input, context) {
      const options = input as BashOutputInput
      const task = backgroundTasks.getTask(context.sessionId, options.task_id)
      if (!task) {
        return { ok: false, content: `Background task not found: ${options.task_id}`, errorCode: 'not_found' }
      }
      if (task.kind !== 'shell') {
        return { ok: false, content: `${options.task_id} is an agent task, not a shell task.`, errorCode: 'precondition_failed' }
      }
      let filter: RegExp | undefined
      if (options.filter !== undefined) {
        try {
          filter = new RegExp(options.filter)
        } catch (error) {
          return {
            ok: false,
            content: `Invalid filter regex: ${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'invalid_input',
          }
        }
      }
      const read = await backgroundTasks.readOutput({
        sessionId: context.sessionId,
        taskId: options.task_id,
        waitMs: options.wait_ms ?? 0,
        ...(filter ? { filter } : {}),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      })
      if (!read) {
        return { ok: false, content: `Background shell not found: ${options.task_id}`, errorCode: 'not_found' }
      }
      const notices = [
        ...(read.droppedBytes > 0 ? [`[${read.droppedBytes} bytes were dropped because the 1MB buffer wrapped]`] : []),
        read.output || '(no new output)',
        ...(read.moreAvailable ? ['[more output available]'] : []),
      ]
      return {
        ok: true,
        content: `Task ${read.task.id} (${read.task.status})\n${notices.join('\n')}`,
      }
    },
  }
}

export const bashOutputTool = createBashOutputTool()
