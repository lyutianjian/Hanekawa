import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
} from '../services/backgroundTasks/registry.js'

export function createKillShellTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
    name: 'KillShell',
    description: 'Terminate a running background Bash task and its child process tree.',
    searchHint: 'stop kill background shell process',
    inputSchema: z.object({ task_id: z.string().min(1) }).strict(),
    riskLevel: 'dangerous',
    isDestructive: true,
    isConcurrencySafe: false,
    userFacingName: () => 'KillShell',
    async execute(input, context) {
      const taskId = (input as { task_id: string }).task_id
      const task = backgroundTasks.getTask(context.sessionId, taskId)
      if (!task) return { ok: false, content: `Background task not found: ${taskId}`, errorCode: 'not_found' }
      if (task.kind !== 'shell') {
        return { ok: false, content: `${taskId} is an agent task, not a shell task.`, errorCode: 'precondition_failed' }
      }
      if (task.status !== 'running') {
        return { ok: true, content: `Shell task ${taskId} is already ${task.status}.` }
      }
      const stopped = await backgroundTasks.killShell(context.sessionId, taskId)
      return {
        ok: true,
        content: `Shell task ${taskId}${stopped?.pid ? ` (PID ${stopped.pid})` : ''} was terminated.`,
      }
    },
  }
}

export const killShellTool = createKillShellTool()
