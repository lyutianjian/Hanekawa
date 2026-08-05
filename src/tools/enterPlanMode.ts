import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './toolNames.js'

const enterPlanModeInputSchema = z.object({}).strict()

const ENTER_PLAN_MODE_TOOL_PROMPT = `Use this tool to enter plan mode when implementation approach is genuinely ambiguous and getting user input before coding would prevent significant rework.

Use when: multiple reasonable architectures exist, requirements are unclear, or the task will significantly restructure existing code.

Skip when: the implementation path is clear, the task follows existing conventions, bug fixes, research tasks, or when the user says "let's do X" — just start.

In plan mode you explore the codebase, design an approach, and present it for approval via ExitPlanMode. Use AskUserQuestion to clarify requirements first.
`

/**
 * EnterPlanMode is a thin request-emitting tool. It does NOT change the
 * permission mode itself; instead it appends a `plan_mode_request`
 * (kind='enter') record to the parent record stream, which the
 * PlanModeManager drains at the start of the next turn. The manager
 * then runs the user-approval prompt and, on approve, transitions the
 * gate via `gate.prepareContextForPlanMode()`.
 *
 * Sub-agent isolation: plan mode is a main-thread abstraction. If the
 * tool is invoked from a sub-agent context (planModeBridge.parentSessionId
 * !== context.sessionId), it returns precondition_failed without
 * emitting a record. agentTool.filterToolsForSubAgent removes the tool
 * from sub-agent toolsets entirely — this guard is defensive.
 *
 * Risk level is 'confirm' so a model running outside plan mode goes
 * through the standard permission gate (the user gets a confirmation
 * dialog before the request is even submitted). Inside plan mode, the
 * tool short-circuits with precondition_failed since plan mode is
 * already active.
 */
export const enterPlanModeTool: Tool = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description: ENTER_PLAN_MODE_TOOL_PROMPT,
  inputSchema: enterPlanModeInputSchema,
  riskLevel: 'confirm',
  isReadOnly: true,
  userFacingName: () => 'Plan',
  getToolUseSummary: () => 'enter plan mode',
  getActivityDescription: () => 'Entering plan mode',
  async execute(_input, context) {
    if (context.getPermissionMode?.() === 'plan') {
      return {
        ok: false,
        content: 'Already in plan mode.',
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
        content: 'Sub-agents cannot enter plan mode. Plan mode is a main-thread abstraction; ask the parent agent to enter plan mode if needed.',
        errorCode: 'precondition_failed',
      }
    }
    await context.planModeBridge.parentAppendRecord({
      id: randomUUID(),
      type: 'plan_mode_request',
      kind: 'enter',
      submittedFromSessionId: context.sessionId,
      createdAt: new Date().toISOString(),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
    })
    return {
      ok: true,
      content: [
        'Plan mode entry submitted; the user will be asked to approve. If approved, plan-mode instructions will be delivered on the next turn.',
        '',
        'In plan mode, you should:',
        '1. Thoroughly explore the codebase to understand existing patterns',
        '2. Identify similar features and architectural approaches',
        '3. Consider multiple approaches and their trade-offs',
        '4. Use AskUserQuestion if you need to clarify the approach',
        '5. Design a concrete implementation strategy',
        '6. When ready, use ExitPlanMode to present your plan for approval',
        '',
        'Remember: DO NOT write or edit any files yet except the plan file. This is a read-only exploration and planning phase.',
      ].join('\n'),
    }
  },
}
