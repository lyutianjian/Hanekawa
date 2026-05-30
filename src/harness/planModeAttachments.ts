/**
 * Plan-mode attachment builders. These produce <system-reminder> strings
 * that the AgentLoop injects as transient user-message context items
 * outside the static system-prompt cache boundary.
 */

export const TURNS_BETWEEN_ATTACHMENTS = 5
export const FULL_REMINDER_EVERY_N_ATTACHMENTS = 5

export interface AttachmentDecisionState {
  active: boolean
  hasExitedThisSession: boolean
  needsExitAttachment: boolean
  toolUseTurnsSinceEntry: number
  attachmentInjections: number
}

export type PlanAttachmentKind = 'full' | 'sparse' | 'reentry' | 'exit'

export function shouldInjectPlanAttachment(state: AttachmentDecisionState): PlanAttachmentKind | undefined {
  if (state.needsExitAttachment) return 'exit'
  if (!state.active) return undefined

  if (state.toolUseTurnsSinceEntry === 0 && state.attachmentInjections === 0) {
    return state.hasExitedThisSession ? 'reentry' : 'full'
  }

  if (state.toolUseTurnsSinceEntry === 0) return undefined
  if (state.toolUseTurnsSinceEntry % TURNS_BETWEEN_ATTACHMENTS !== 0) return undefined
  return state.attachmentInjections % FULL_REMINDER_EVERY_N_ATTACHMENTS === 0
    ? 'full'
    : 'sparse'
}

const PLAN_PHASE4_CONTROL = `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made - the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use tools, run tests)`

/**
 * Full plan-mode reminder. Deeply aligned with Claude Code's plan-mode V2
 * workflow: read-only exploration, one writable plan file, AskUserQuestion
 * for clarifications, and ExitPlanMode as the only plan-approval surface.
 */
export function buildFullPlanModeReminder(planFilePath: string, planExists: boolean = false): string {
  const planFileInfo = planExists
    ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the Write tool.`

  return [
    '<system-reminder>',
    'Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.',
    '',
    '## Plan File Info:',
    planFileInfo,
    'You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.',
    '',
    '## Plan Workflow',
    '',
    '### Phase 1: Initial Understanding',
    'Goal: Gain a comprehensive understanding of the user\'s request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.',
    '',
    '1. Focus on understanding the user\'s request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused - avoid proposing new code when suitable implementations already exist.',
    '',
    '2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.',
    '   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you\'re making a small targeted change.',
    '   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.',
    '   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1).',
    '   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns.',
    '',
    '### Phase 2: Design',
    'Goal: Design an implementation approach.',
    '',
    'Launch plan agent(s) to design the implementation based on the user\'s intent and your exploration results from Phase 1.',
    '',
    '**Guidelines:**',
    '- **Default**: Launch at least 1 plan agent for most tasks - it helps validate your understanding and consider alternatives',
    '- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)',
    '',
    'In the agent prompt:',
    '- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces',
    '- Describe requirements and constraints',
    '- Request a detailed implementation plan',
    '',
    '### Phase 3: Review',
    'Goal: Review the plan from Phase 2 and ensure alignment with the user\'s intentions.',
    '1. Read the critical files identified by the agent to deepen your understanding',
    '2. Ensure that the plan aligns with the user\'s original request',
    '3. Use AskUserQuestion to clarify any remaining questions with the user',
    '',
    PLAN_PHASE4_CONTROL,
    '',
    'Do NOT present the final plan as ordinary assistant text and then ask whether to proceed. The approval UI appears only when you call ExitPlanMode.',
    '',
    '### Phase 5: Call ExitPlanMode',
    'At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.',
    'This is critical - your turn should only end with either using AskUserQuestion OR calling ExitPlanMode. Do not stop unless it\'s for these 2 reasons.',
    '',
    'Hanekawa note: ExitPlanMode accepts an optional inline plan. Prefer writing the plan file first, but if your complete final plan is already in context and no plan file was written, call ExitPlanMode({ plan: "..." }) with the complete plan instead of asking in text.',
    '',
    '**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ExitPlanMode.',
    '',
    'NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using AskUserQuestion. Don\'t make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.',
    '</system-reminder>',
  ].join('\n')
}

export function buildSparsePlanModeReminder(planFilePath?: string): string {
  const planPathSuffix = planFilePath ? ` (${planFilePath})` : ''
  return [
    '<system-reminder>',
    `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file${planPathSuffix}. Follow 5-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
    '</system-reminder>',
  ].join('\n')
}

export function buildPlanModeReentryReminder(planFilePath: string, planExists: boolean = true): string {
  if (!planExists) {
    return [
      '<system-reminder>',
      'You are returning to plan mode after having previously exited it. Your previous plan file at ' + planFilePath + ' no longer exists. Treat this as a fresh planning session and follow the 5-phase plan workflow from the top. When the plan is ready, call ExitPlanMode rather than asking for approval in text.',
      '</system-reminder>',
    ].join('\n')
  }

  return [
    '<system-reminder>',
    '## Re-entering Plan Mode',
    '',
    'You are returning to plan mode after having previously exited it. A plan file exists at ' + planFilePath + ' from your previous planning session.',
    '',
    '**Before proceeding with any new planning, you should:**',
    '1. Read the existing plan file to understand what was previously planned',
    '2. Evaluate the user\'s current request against that plan',
    '3. Decide how to proceed:',
    '   - **Different task**: If the user\'s request is for a different task - even if it\'s similar or related - start fresh by overwriting the existing plan',
    '   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections',
    '4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ExitPlanMode',
    '',
    'Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first. When the plan is ready, call ExitPlanMode rather than asking for approval in text.',
    '</system-reminder>',
  ].join('\n')
}

export function buildPlanModeExitReminder(planContent: string): string {
  // Aligned with Claude Code's ExitPlanModeV2Tool tool_result body.
  const trimmed = planContent.trim()
  const lines = [
    '<system-reminder>',
    '## Exited Plan Mode',
    '',
    'User has approved your plan. You can now start coding. Start with updating your todo list (TodoWrite) if applicable, then proceed with the implementation.',
  ]
  if (trimmed.length > 0) {
    lines.push('', 'Approved plan content:', trimmed)
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

export function buildPlanFileReferenceReminder(planContent: string): string {
  return [
    '<system-reminder>',
    'Plan mode is active. Current draft plan file content:',
    planContent.trim(),
    '</system-reminder>',
  ].join('\n')
}
