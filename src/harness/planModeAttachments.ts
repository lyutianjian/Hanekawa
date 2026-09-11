/**
 * Plan-mode attachment builders. These produce <system-reminder> strings
 * that the AgentLoop injects as transient user-message context items
 * outside the static system-prompt cache boundary.
 */

import { wrapInSystemReminder } from './systemReminder.js'

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

  return wrapInSystemReminder([
    'Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.',
    '',
    '## Plan File Info:',
    planFileInfo,
    'You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.',
    '',
    '## Plan Workflow',
    '',
    '### Phase 1: Initial Understanding',
    'Understand the request and the code around it before designing anything. Search for existing functions, utilities, and patterns to reuse - avoid proposing new code when suitable implementations already exist. In this phase, the only subagent type you may use is `explore`; delegate breadth-first search to it when the scope is uncertain or several areas of the codebase are involved, giving each agent a distinct search focus and launching independent ones in parallel (single message, multiple tool calls).',
    '',
    '### Phase 2: Design',
    'Design the implementation from the user\'s intent and what Phase 1 found. Use `plan` subagents when an approach needs independent design or alternatives are worth comparing; give each the filenames, code-path traces, requirements, and constraints from Phase 1, and ask for a detailed implementation plan.',
    '',
    '### Phase 3: Review',
    'Goal: Review the plan(s) from Phase 2 and ensure alignment with the user\'s intentions.',
    '1. Read the critical files identified by agents to deepen your understanding',
    '2. Ensure that the plans align with the user\'s original request',
    '3. Use AskUserQuestion to clarify any remaining questions with the user',
    '',
    PLAN_PHASE4_CONTROL,
    '',
    '### Phase 5: Call ExitPlanMode',
    'At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.',
    'This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it\'s for these 2 reasons',
    '',
    'NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don\'t make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.',
  ].join('\n'))
}

export function buildSparsePlanModeReminder(planFilePath?: string): string {
  const planPathSuffix = planFilePath ? ` (${planFilePath})` : ''
  return wrapInSystemReminder(
    `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file${planPathSuffix}. Follow 5-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
  )
}

export function buildPlanModeReentryReminder(planFilePath: string, planExists: boolean = true): string {
  if (!planExists) {
    return wrapInSystemReminder(
      'You are returning to plan mode after having previously exited it. Your previous plan file at ' + planFilePath + ' no longer exists. Treat this as a fresh planning session and follow the 5-phase plan workflow from the top. When the plan is ready, call ExitPlanMode rather than asking for approval in text.',
    )
  }

  return wrapInSystemReminder([
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
  ].join('\n'))
}

export function buildPlanModeExitReminder(planContent: string): string {
  // Aligned with Claude Code's ExitPlanModeV2Tool tool_result body.
  const trimmed = planContent.trim()
  if (trimmed.length === 0) {
    return wrapInSystemReminder('User has approved exiting plan mode. You can now proceed.')
  }

  const lines = [
    '## Exited Plan Mode',
    '',
    'User has approved your plan. You can now start coding. Start with updating your task list (TaskCreate/TaskUpdate) if applicable, then proceed with the implementation.',
  ]
  if (trimmed.length > 0) {
    lines.push('', 'Approved plan content:', trimmed)
  }
  return wrapInSystemReminder(lines.join('\n'))
}

export function buildPlanFileReferenceReminder(slug: string, planPath: string): string {
  return wrapInSystemReminder(
    `Plan mode is active. You are working on plan '${slug}'. Plan file: ${planPath}\nRead it with the Read tool if you need to reference or continue editing it.`,
  )
}
