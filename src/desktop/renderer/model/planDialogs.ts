import {
  ENTER_PLAN_OPTIONS,
  exitPlanDecisionFor,
  exitPlanOptionsFor,
  isEmptyPlan,
  previewMarkdownLines,
  type DecisionOption,
  type EnterPlanOption,
} from '../../../runtime/planPresentation.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../../harness/planModeManager.js'

/**
 * The two plan-mode dialogs as data.
 *
 * The options, the elevated-shortcut rule and which half of the decision carries
 * the plan text all come from `runtime/planPresentation.ts`, so the terminal and
 * the desktop cannot offer different choices. What lives here is only the part
 * that is per-view: cursor position, the feedback buffer, and how a keystroke
 * maps onto them.
 *
 * The shipped renderer auto-approved entry and auto-rejected exit while throwing
 * away the plan text, which made plan mode unusable on the desktop.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

/** Lines of plan to show before collapsing the middle. */
export const PLAN_PREVIEW_LINES = 40

// --- entering ---------------------------------------------------------------

export interface EnterPlanViewModel {
  readonly title: string
  readonly body: string
  readonly bullets: readonly string[]
  readonly reassurance: string
  readonly options: readonly EnterPlanOption[]
  readonly selectedIndex: number
  readonly hint: string
}

export function enterPlanViewModel(selectedIndex = 0): EnterPlanViewModel {
  return {
    title: 'Enter plan mode?',
    body: 'The agent wants to enter plan mode to explore and design an implementation approach.',
    bullets: [
      'Explore the codebase thoroughly',
      'Identify existing patterns',
      'Design an implementation strategy',
      'Present a plan for your approval',
    ],
    reassurance: 'No code changes will be made until you approve the plan.',
    options: ENTER_PLAN_OPTIONS,
    selectedIndex: clamp(selectedIndex, 0, ENTER_PLAN_OPTIONS.length - 1),
    hint: '[↑↓] Move  [1-2] Quick  [Enter] Select  [Esc] Decline',
  }
}

export type EnterPlanIntent =
  | { kind: 'move'; selectedIndex: number }
  | { kind: 'answer'; approved: boolean }
  | { kind: 'none' }

export function enterPlanKeyToIntent(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean },
  state: { selectedIndex: number },
): EnterPlanIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  const last = ENTER_PLAN_OPTIONS.length - 1

  switch (event.key) {
    case 'ArrowUp':
      return { kind: 'move', selectedIndex: clamp(state.selectedIndex - 1, 0, last) }
    case 'ArrowDown':
      return { kind: 'move', selectedIndex: clamp(state.selectedIndex + 1, 0, last) }
    case '1':
      return { kind: 'answer', approved: true }
    case '2':
      return { kind: 'answer', approved: false }
    case 'Enter':
      return { kind: 'answer', approved: ENTER_PLAN_OPTIONS[state.selectedIndex]?.value === 'yes' }
    case 'Escape':
      // Declining entry is safe: the agent simply keeps working as it was.
      return { kind: 'answer', approved: false }
    default:
      return { kind: 'none' }
  }
}

// --- exiting ----------------------------------------------------------------

export interface ExitPlanState {
  readonly input: ExitDialogInput
  readonly selectedIndex: number
  readonly feedback: string
}

export interface ExitPlanViewModel {
  readonly title: string
  readonly planPreview: string
  readonly planFilePath: string
  readonly isEmptyPlan: boolean
  readonly options: readonly DecisionOption[]
  readonly selectedIndex: number
  /** True when the focused option is the one that collects feedback. */
  readonly feedbackFocused: boolean
  readonly feedback: string
  readonly hint: string
}

export function createExitPlanState(input: ExitDialogInput): ExitPlanState {
  return { input, selectedIndex: 0, feedback: '' }
}

export function exitPlanViewModel(state: ExitPlanState): ExitPlanViewModel {
  const options = exitPlanOptionsFor({
    planContent: state.input.planContent,
    isBypassAvailable: state.input.isBypassAvailable === true,
  })
  const selectedIndex = clamp(state.selectedIndex, 0, options.length - 1)
  const empty = isEmptyPlan(state.input.planContent)

  return {
    title: empty ? 'Exit plan mode?' : 'Ready to code?',
    planPreview: empty
      ? 'Hanekawa wants to exit plan mode'
      : previewMarkdownLines(state.input.planContent, PLAN_PREVIEW_LINES),
    planFilePath: state.input.planFilePath,
    isEmptyPlan: empty,
    options,
    selectedIndex,
    feedbackFocused: options[selectedIndex]?.kind === 'reject',
    feedback: state.feedback,
    hint: empty
      ? '[↑↓] Move  [1-2] Quick  [Enter] Select  [Esc] Keep planning'
      : `[↑↓] Move  [1-${options.length}] Quick  [Enter] Select  [Esc] Keep planning`,
  }
}

export type ExitPlanIntent =
  | { kind: 'move'; selectedIndex: number }
  | { kind: 'select'; selectedIndex: number }
  | { kind: 'commit' }
  | { kind: 'feedback-type'; text: string }
  | { kind: 'feedback-backspace' }
  | { kind: 'reject' }
  | { kind: 'none' }

export function exitPlanKeyToIntent(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  view: ExitPlanViewModel,
): ExitPlanIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  const last = view.options.length - 1

  switch (event.key) {
    case 'ArrowUp':
      return { kind: 'move', selectedIndex: clamp(view.selectedIndex - 1, 0, last) }
    case 'ArrowDown':
      return { kind: 'move', selectedIndex: clamp(view.selectedIndex + 1, 0, last) }
    case 'Enter':
      return { kind: 'commit' }
    case 'Escape':
      // Keep planning, with no feedback. Rejecting is always safe here.
      return { kind: 'reject' }
    case 'Backspace':
      return view.feedbackFocused ? { kind: 'feedback-backspace' } : { kind: 'none' }
    default:
      break
  }

  const slot = Number.parseInt(event.key, 10)
  if (!Number.isNaN(slot) && slot >= 1 && slot <= view.options.length) {
    // A numeric hotkey on the reject slot moves there rather than rejecting
    // outright, so the user gets to type feedback first.
    return view.options[slot - 1]?.kind === 'reject'
      ? { kind: 'move', selectedIndex: slot - 1 }
      : { kind: 'select', selectedIndex: slot - 1 }
  }

  if (view.feedbackFocused && event.key.length === 1) {
    return { kind: 'feedback-type', text: event.key }
  }

  return { kind: 'none' }
}

export type ExitPlanOutcome =
  | { readonly state: ExitPlanState }
  | { readonly state: ExitPlanState; readonly decision: ExitPlanDecision }

export function applyExitPlanIntent(state: ExitPlanState, intent: ExitPlanIntent): ExitPlanOutcome {
  const view = exitPlanViewModel(state)

  switch (intent.kind) {
    case 'move':
      return { state: { ...state, selectedIndex: intent.selectedIndex } }

    case 'select': {
      const option = view.options[intent.selectedIndex]
      if (!option) return { state }
      return {
        state: { ...state, selectedIndex: intent.selectedIndex },
        decision: decisionFor(option, state),
      }
    }

    case 'commit': {
      const option = view.options[view.selectedIndex]
      if (!option) return { state }
      return { state, decision: decisionFor(option, state) }
    }

    case 'feedback-type':
      return { state: { ...state, feedback: state.feedback + intent.text } }

    case 'feedback-backspace':
      return { state: { ...state, feedback: state.feedback.slice(0, -1) } }

    case 'reject':
      return { state, decision: { kind: 'reject', feedback: '' } }

    case 'none':
      return { state }
  }

  return assertNever(intent)
}

function decisionFor(option: DecisionOption, state: ExitPlanState): ExitPlanDecision {
  return exitPlanDecisionFor(option, {
    planContent: state.input.planContent,
    feedback: state.feedback,
  })
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  return value > max ? max : value
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan dialog intent: ${JSON.stringify(value)}`)
}
