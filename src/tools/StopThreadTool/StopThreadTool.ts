import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded } from '../coordinationShared.js'
import { DESCRIPTION, STOP_THREAD_TOOL_NAME } from './prompt.js'

export { STOP_THREAD_TOOL_NAME }

export const stopThreadInputSchema = z.object({
  threadId: z.string().trim().min(1),
})

export function createStopThreadTool(host: CoordinationHost): Tool {
  return {
    name: STOP_THREAD_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: stopThreadInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'StopThread',
    async execute(rawInput, context) {
      const input = stopThreadInputSchema.parse(rawInput)
      return guarded('StopThread', async () => {
        const caller = callerOf(context)
        await host.stopThread(caller, input.threadId)
        return {
          ok: true,
          content: `Stopped thread ${input.threadId}.`,
          metadata: { display: { summary: 'Stopped thread' } },
        }
      })
    },
  }
}
