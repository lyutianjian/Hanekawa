import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded } from '../coordinationShared.js'
import { DESCRIPTION, MESSAGE_THREAD_TOOL_NAME } from './prompt.js'

export { MESSAGE_THREAD_TOOL_NAME }

export const messageThreadInputSchema = z.object({
  threadId: z.string().trim().min(1),
  text: z.string().trim().min(1),
})

export function createMessageThreadTool(host: CoordinationHost): Tool {
  return {
    name: MESSAGE_THREAD_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: messageThreadInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'MessageThread',
    async execute(rawInput, context) {
      const input = messageThreadInputSchema.parse(rawInput)
      return guarded('MessageThread', async () => {
        const caller = callerOf(context)
        await host.messageThread(caller, input.threadId, input.text)
        return {
          ok: true,
          content: `Message queued for thread ${input.threadId}.`,
          metadata: { display: { summary: 'Messaged thread' } },
        }
      })
    },
  }
}
