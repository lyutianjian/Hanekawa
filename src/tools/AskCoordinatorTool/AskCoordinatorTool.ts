import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import type { CoordinationHost } from '../../runtime/protocol/coordinationHost.js'
import { callerOf, guarded } from '../coordinationShared.js'
import { DESCRIPTION, ASK_COORDINATOR_TOOL_NAME } from './prompt.js'

export { ASK_COORDINATOR_TOOL_NAME }

export const askCoordinatorInputSchema = z.object({
  question: z.string().trim().min(1),
})

export function createAskCoordinatorTool(host: CoordinationHost): Tool {
  return {
    name: ASK_COORDINATOR_TOOL_NAME,
    sessionRoles: ['thread'],
    description: DESCRIPTION,
    inputSchema: askCoordinatorInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    userFacingName: () => 'AskCoordinator',
    async execute(rawInput, context) {
      const input = askCoordinatorInputSchema.parse(rawInput)
      return guarded('AskCoordinator', async () => {
        const caller = callerOf(context)
        await host.askCoordinator(caller, input.question)
        return {
          ok: true,
          content: 'Your question was sent to the coordinator. End your turn now: do not call more tools or write more than a one-line note. The answer will arrive as a new message.',
          metadata: { display: { summary: 'Asked the coordinator' } },
        }
      })
    },
  }
}
