import type { ExitPlanDecision } from '../harness/planModeManager.js'

/**
 * How the two plan-mode dialogs are presented, independent of any view.
 *
 * These were pure functions inside `ExitPlanModeDialog.tsx` and
 * `EnterPlanModeDialog.tsx`, which value-import `ink`, `react`,
 * `node:child_process` and `readPlan` — so a desktop renderer could not reach
 * them without dragging all four into a browser bundle. They live here for the
 * same reason `permissionPresentation.ts` does: a terminal dialog and a DOM one
 * must offer the *same* options in the same order, and a second copy of the
 * slot logic would drift.
 *
 * Every cross-layer import in this file is type-only. Both dialogs re-export
 * what they used to define, so existing importers are unaffected.
 */

export interface DecisionOption {
  readonly kind: ExitPlanDecision['kind']
  readonly label: string
}

export interface EnterPlanOption {
  readonly value: 'yes' | 'no'
  readonly label: string
  readonly hotkey: '1' | '2'
}

export const ENTER_PLAN_OPTIONS: readonly EnterPlanOption[] = [
  { value: 'yes', label: 'Yes, enter plan mode', hotkey: '1' },
  { value: 'no', label: 'No, start implementing now', hotkey: '2' },
] as const

/**
 * Build the option list for the exit dialog. When bypass is available the user
 * sees parallel "elevated" choices for both clear-context and keep-context
 * paths, mirroring Claude Code's slot logic in `buildPlanApprovalOptions`.
 *
 * Hotkeys are assigned by index 1..N in render order so the labels stay
 * consistent without per-option metadata.
 */
export function buildExitPlanModeOptions(input: boolean | {
  isBypassAvailable?: boolean
}): readonly DecisionOption[] {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  const options: DecisionOption[] = []

  // Slot 1: keep-context with elevated mode (higher privilege first).
  if (isBypassAvailable) {
    options.push({
      kind: 'approve_bypass_keep',
      label: 'Yes, and bypass permissions',
    })
  } else {
    options.push({
      kind: 'approve_acceptEdits_keep',
      label: 'Yes, auto-accept edits',
    })
  }

  // Slot 2: always-present default keep-context (manual approval).
  options.push({
    kind: 'approve_restore_keep',
    label: 'Yes, manually approve edits',
  })

  // Slot 3: always-present reject with feedback.
  options.push({
    kind: 'reject',
    label: 'No, keep planning',
  })

  return options
}

export type ElevatedExitPlanModeDecision = 'approve_bypass_keep' | 'approve_acceptEdits_keep'

export function elevatedExitPlanModeDecision(input: boolean | {
  isBypassAvailable?: boolean
}): ElevatedExitPlanModeDecision {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  if (isBypassAvailable) return 'approve_bypass_keep'
  return 'approve_acceptEdits_keep'
}

/**
 * The two options an *empty* plan gets. An empty plan has nothing to
 * auto-accept, so the elevated slot is dropped rather than shown inert.
 */
export const EMPTY_PLAN_OPTIONS: readonly DecisionOption[] = [
  { kind: 'approve_restore_keep', label: 'Yes' },
  { kind: 'reject', label: 'No' },
] as const

export function isEmptyPlan(planContent: string): boolean {
  return planContent.trim().length === 0
}

/** The option list for a plan of either kind, so a view picks neither by hand. */
export function exitPlanOptionsFor(input: {
  planContent: string
  isBypassAvailable?: boolean
}): readonly DecisionOption[] {
  if (isEmptyPlan(input.planContent)) return EMPTY_PLAN_OPTIONS
  return buildExitPlanModeOptions({ isBypassAvailable: input.isBypassAvailable === true })
}

/**
 * Turn a selected option into the decision the manager expects.
 *
 * `reject` is the only kind that carries feedback, and the approvals are the
 * only ones that carry the plan text — getting that backwards silently drops
 * either the user's note or the plan the agent is about to execute.
 */
export function exitPlanDecisionFor(
  option: DecisionOption,
  state: { planContent: string; feedback: string },
): ExitPlanDecision {
  if (option.kind === 'reject') return { kind: 'reject', feedback: state.feedback }
  return { kind: option.kind, planContent: state.planContent }
}

export function previewMarkdownLines(content: string, maxLines: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) return content
  const safeMax = Math.max(1, maxLines)
  if (safeMax === 1) {
    return `${lines[0] ?? ''}\n[... ${lines.length - 1} lines omitted from preview ...]`
  }

  const omitted = lines.length - safeMax + 1
  const headCount = Math.max(1, Math.ceil((safeMax - 1) * 0.6))
  const tailCount = Math.max(0, safeMax - 1 - headCount)
  const head = lines.slice(0, headCount)
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : []
  return [
    ...head,
    `[... ${omitted} lines omitted from preview ...]`,
    ...tail,
  ].join('\n')
}
