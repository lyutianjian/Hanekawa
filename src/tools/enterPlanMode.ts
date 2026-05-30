import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './toolNames.js'

const enterPlanModeInputSchema = z.object({}).strict()

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
  description: 'Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n## When to Use This Tool\n\nPlan mode is valuable when the implementation approach is genuinely unclear. Use it when:\n\n1. **Significant Architectural Ambiguity**: Multiple reasonable approaches exist and the choice meaningfully affects the codebase.\n2. **Unclear Requirements**: You need to explore and clarify before you can make progress.\n3. **High-Impact Restructuring**: The task will significantly restructure existing code and getting buy-in first reduces risk.\n\n## When NOT to Use This Tool\n\nSkip plan mode when you can reasonably infer the right approach: straightforward tasks, specific user requests with a clear path, features following obvious existing conventions, bug fixes where the fix is clear, and pure research tasks (use the explore sub-agent instead).\n\nThis tool REQUIRES user approval — they must consent to entering plan mode.',
  inputSchema: enterPlanModeInputSchema,
  riskLevel: 'confirm',
  isReadOnly: true,
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
