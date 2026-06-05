import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from './toolNames.js'

const exitPlanModeInputSchema = z.object({
  plan: z.string().optional(),
}).strict()

const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
`

/**
 * ExitPlanMode is a thin request-emitting tool. It does NOT change the
 * permission mode itself; instead it appends a `plan_mode_request`
 * (kind='exit') record to the parent record stream, which the
 * PlanModeManager drains at the start of the next turn. The manager
 * then opens the exit dialog, and on approve
 * transitions the gate via `gate.restoreFromPlanMode()`.
 *
 * If `plan` is provided inline, it is attached to the request record
 * so the manager can persist it directly. If absent, the manager falls
 * back to reading the plan file from disk.
 *
 * Sub-agent isolation: plan mode is a main-thread abstraction. If the
 * tool is invoked from a sub-agent context (planModeBridge.parentSessionId
 * !== context.sessionId), it returns precondition_failed without
 * emitting a record.
 */
export const exitPlanModeTool: Tool = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: EXIT_PLAN_MODE_V2_TOOL_PROMPT,
  inputSchema: exitPlanModeInputSchema,
  riskLevel: 'safe',
  isReadOnly: true,
  userFacingName: () => 'Plan',
  getToolUseSummary: () => 'submit plan',
  getActivityDescription: () => 'Submitting plan',
  async execute(input, context) {
    if (context.getPermissionMode?.() !== 'plan') {
      return {
        ok: false,
        content: 'ExitPlanMode can only be called in plan mode.',
        errorCode: 'precondition_failed',
      }
    }

    if (!context.planModeBridge) {
      return {
        ok: false,
        content: 'Plan mode is not available in this context.',
        errorCode: 'precondition_failed',
      }
    }

    if (context.planModeBridge.parentSessionId !== context.sessionId) {
      return {
        ok: false,
        content: 'Sub-agents cannot exit plan mode directly. Ask the parent agent to exit plan mode.',
        errorCode: 'precondition_failed',
      }
    }

    const parsed = exitPlanModeInputSchema.parse(input)
    const plan = parsed.plan?.trim()

    await context.planModeBridge.parentAppendRecord({
      id: randomUUID(),
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: context.sessionId,
      ...(plan ? { planContent: plan } : {}),
      createdAt: new Date().toISOString(),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
    })

    return {
      ok: true,
      content: 'Plan submitted for review. The user will be shown the plan with options to approve, reject, or edit it.',
    }
  },
}
