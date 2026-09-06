import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import {
  AgentAddressError,
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
} from '../../services/backgroundTasks/registry.js'
import { DESCRIPTION } from './prompt.js'

const sendMessageInputSchema = z.object({
  agent_id: z.string().trim().min(1).describe('Id or name of a sub-agent started in this session by the Agent tool.'),
  message: z.string().trim().min(1).describe('The follow-up message to deliver.'),
}).strict()

export function createSendMessageTool(
  backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry,
): Tool {
  return {
    name: 'SendMessage',
    description: DESCRIPTION,
    searchHint: 'continue resume follow up message sub-agent',
    inputSchema: sendMessageInputSchema,
    riskLevel: 'safe',
    isReadOnly: false,
    isConcurrencySafe: false,
    userFacingName: () => 'SendMessage',
    getToolUseSummary(input) {
      const agentId = typeof input === 'object' && input !== null
        ? (input as { agent_id?: unknown }).agent_id
        : undefined
      return typeof agentId === 'string' ? agentId : null
    },
    async execute(input, context) {
      const parsed = sendMessageInputSchema.parse(input)
      try {
        const delivery = await backgroundTasks.sendAgentMessage(
          context.sessionId,
          parsed.agent_id,
          parsed.message,
          context,
        )
        if (delivery.kind === 'queued') {
          return {
            ok: true,
            content: `Message queued for running sub-agent ${delivery.agentId}.`,
            metadata: { agentId: delivery.agentId, delivery: 'queued' },
          }
        }
        return {
          ...delivery.result,
          metadata: {
            ...delivery.result.metadata,
            agentId: delivery.agentId,
            delivery: 'resumed',
          },
        }
      } catch (error) {
        if (error instanceof AgentAddressError) {
          return { ok: false, content: error.message, errorCode: error.code }
        }
        return {
          ok: false,
          content: `Failed to message sub-agent: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed',
        }
      }
    },
  }
}

export const sendMessageTool = createSendMessageTool()
