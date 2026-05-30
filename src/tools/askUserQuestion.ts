import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH, ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from './toolNames.js'

const questionOptionSchema = z.object({
  label: z.string().min(1).describe(
    'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
  ),
  description: z.string().describe(
    'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  ),
}).strict()

const questionSchema = z.object({
  question: z.string().min(1).describe(
    'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  ),
  header: z.string().min(1).max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH).describe(
    `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
  ),
  options: z.array(questionOptionSchema).min(2).max(4).describe(
    "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
  ),
  multiSelect: z.boolean().optional().default(false).describe(
    'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
  ),
}).strict()

const askUserQuestionInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).describe('Questions to ask the user (1-4 questions)'),
}).strict()

/**
 * AskUserQuestion — multiple-choice clarification tool.
 *
 * Aligned with Claude Code's AskUserQuestionTool. Use during a turn to
 * resolve genuine ambiguity (architectural choices, missing requirements,
 * preferences) BEFORE producing the final result. Particularly important
 * during plan mode, where it pairs with ExitPlanMode as the only two
 * legitimate ways to end a turn.
 *
 * Sub-agent isolation: this is a main-thread tool. Sub-agents see the
 * tool removed from their toolset (via NESTED_AGENT_FORBIDDEN_TOOLS).
 * The execute path also guards on `askUserQuestionBridge` presence.
 */
export const askUserQuestionTool: Tool = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.`,
  inputSchema: askUserQuestionInputSchema,
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: false,
  async execute(input, context) {
    const parsed = askUserQuestionInputSchema.parse(input)

    if (!context.askUserQuestionBridge) {
      return {
        ok: false,
        content: 'AskUserQuestion is unavailable in this runtime (no UI bridge wired).',
        errorCode: 'precondition_failed',
      }
    }

    // Sub-agent guard: agentTool.filterToolsForSubAgent already removes
    // this tool from sub-agent toolsets, but if a custom agent definition
    // smuggles it through we still refuse.
    if (context.planModeBridge && context.planModeBridge.parentSessionId !== context.sessionId) {
      return {
        ok: false,
        content: 'AskUserQuestion is a main-thread tool. Sub-agents must summarize findings instead of asking the user directly.',
        errorCode: 'precondition_failed',
      }
    }

    const questions = parsed.questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options,
      multiSelect: q.multiSelect ?? false,
    }))

    const result = await context.askUserQuestionBridge.ask({ questions })

    if (result.kind === 'rejected') {
      const fb = result.feedback?.trim()
      const tail = fb && fb.length > 0 ? ` Feedback: ${fb}` : ''
      return {
        ok: false,
        content: `User declined to answer the questions.${tail}`,
        errorCode: 'permission_denied',
      }
    }

    const answersText = Object.entries(result.answers)
      .map(([q, a]) => `"${q}"="${a}"`)
      .join(', ')

    return {
      ok: true,
      content: `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`,
      metadata: { answers: result.answers },
    }
  },
}
