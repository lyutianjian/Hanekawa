import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded } from '../coordinationShared.js'
import { DESCRIPTION, RESOLVE_THREAD_TOOL_NAME } from './prompt.js'

export { RESOLVE_THREAD_TOOL_NAME }

export const resolveThreadInputSchema = z.object({
  threadId: z.string().trim().min(1),
  note: z.string().trim().min(1).optional(),
})

export function createResolveThreadTool(host: CoordinationHost): Tool {
  return {
    name: RESOLVE_THREAD_TOOL_NAME,
    sessionRoles: ['coordinator'],
    description: DESCRIPTION,
    inputSchema: resolveThreadInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'ResolveThread',
    async execute(rawInput, context) {
      const input = resolveThreadInputSchema.parse(rawInput)
      return guarded('ResolveThread', async () => {
        const caller = callerOf(context)
        await host.resolveThread(caller, input.threadId, input.note)
        return {
          ok: true,
          content: `Resolved thread ${input.threadId}.`,
          metadata: { display: { summary: 'Resolved thread' } },
        }
      })
    },
  }
}
