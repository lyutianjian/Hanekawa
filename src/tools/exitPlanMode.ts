import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from './toolNames.js'

const exitPlanModeInputSchema = z.object({
  plan: z.string().min(1),
}).strict()

export const exitPlanModeTool: Tool = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: 'Present the completed plan to the user and exit plan mode before taking action.',
  inputSchema: exitPlanModeInputSchema,
  riskLevel: 'safe',
  async execute(input, context) {
    if (context.getPermissionMode?.() !== 'plan') {
      return {
        ok: false,
        content: 'ExitPlanMode can only be called in plan mode.',
        errorCode: 'precondition_failed',
      }
    }

    const parsed = exitPlanModeInputSchema.parse(input)
    const plan = parsed.plan.trim()
    if (plan.length === 0) {
      return {
        ok: false,
        content: 'Plan must not be empty.',
        errorCode: 'invalid_input',
      }
    }

    const restoredMode = context.exitPlanMode?.() ?? 'default'
    if (!context.exitPlanMode) {
      context.setPermissionMode?.(restoredMode)
    }

    return {
      ok: true,
      content: `Plan presented. Permission mode switched to ${restoredMode}.`,
      metadata: { assistantMessageContent: plan },
    }
  },
}
