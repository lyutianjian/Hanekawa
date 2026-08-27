import {
  enterPlanOptions,
  exitPlanDecisionFor,
  exitPlanOptionsFor,
  isEmptyPlan,
  previewMarkdownLines,
  type DecisionOption,
  type EnterPlanOption,
} from '../../../runtime/planPresentation.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../../harness/planModeManager.js'
import type { DialogAction } from './dialogActions.js'
import { UI_LOCALE } from './locale.js'

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

/**
 * Resolved once, at module scope, because the view and the key map must read
 * the *same* array: `enterPlanKeyToIntent` answers Enter by indexing it, so a
 * second call would let the two disagree about which option index 0 is.
 */
const ENTER_OPTIONS = enterPlanOptions(UI_LOCALE)

// --- entering ---------------------------------------------------------------

export interface EnterPlanViewModel {
  readonly title: string
  readonly body: string
  readonly bullets: readonly string[]
  readonly reassurance: string
  readonly options: readonly EnterPlanOption[]
  readonly selectedIndex: number
  /** The options again, as buttons: here an option *is* the action. */
  readonly actions: readonly DialogAction[]
}

export function enterPlanViewModel(selectedIndex = 0): EnterPlanViewModel {
  return {
    title: '进入计划模式？',
    body: '助手希望进入计划模式，先探索代码并设计实现方案。',
    bullets: [
      '通读相关代码',
      '找出既有的模式与惯例',
      '设计实现策略',
      '给出方案供你确认',
    ],
    reassurance: '在你确认方案之前，不会修改任何代码。',
    options: ENTER_OPTIONS,
    selectedIndex: clamp(selectedIndex, 0, ENTER_OPTIONS.length - 1),
    // Entering plan mode changes nothing on disk, so neither option is danger.
    actions: ENTER_OPTIONS.map((option, index) => ({
      label: option.label,
      shortcut: option.hotkey,
      role: option.value === 'yes' ? 'primary' : 'secondary',
      slot: index,
    })),
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
  const last = ENTER_OPTIONS.length - 1

  switch (event.key) {
    case 'ArrowUp':
      return { kind: 'move', selectedIndex: clamp(state.selectedIndex - 1, 0, last) }
    case 'ArrowDown':
      return { kind: 'move', selectedIndex: clamp(state.selectedIndex + 1, 0, last) }
    case '1':
      return enterPlanIndexToIntent(0)
    case '2':
      return enterPlanIndexToIntent(1)
    case 'Enter':
      return { kind: 'answer', approved: ENTER_OPTIONS[state.selectedIndex]?.value === 'yes' }
    case 'Escape':
      // Declining entry is safe: the agent simply keeps working as it was.
      return { kind: 'answer', approved: false }
    default:
      return { kind: 'none' }
  }
}

/**
 * A slot to an intent, for both the numeric hotkey and a click on the row.
 *
 * Reads `ENTER_OPTIONS` rather than hard-coding "1 is yes", for the reason that
 * array is resolved once at module scope: the view, the key map and the mouse
 * must all agree on which option index 0 is.
 */
export function enterPlanIndexToIntent(index: number): EnterPlanIntent {
  const option = ENTER_OPTIONS[index]
  if (!option) return { kind: 'none' }
  return { kind: 'answer', approved: option.value === 'yes' }
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
  /** Dialog-level buttons; the options themselves stay a row list. */
  readonly actions: readonly DialogAction[]
}

export function createExitPlanState(input: ExitDialogInput): ExitPlanState {
  return { input, selectedIndex: 0, feedback: '' }
}

export function exitPlanViewModel(state: ExitPlanState): ExitPlanViewModel {
  const options = exitPlanOptionsFor({
    planContent: state.input.planContent,
    isBypassAvailable: state.input.isBypassAvailable === true,
    locale: UI_LOCALE,
  })
  const selectedIndex = clamp(state.selectedIndex, 0, options.length - 1)
  const empty = isEmptyPlan(state.input.planContent)

  return {
    title: empty ? '退出计划模式？' : '可以开始写代码了吗？',
    planPreview: empty
      ? 'Hanekawa 希望退出计划模式'
      : previewMarkdownLines(state.input.planContent, PLAN_PREVIEW_LINES, UI_LOCALE),
    planFilePath: state.input.planFilePath,
    isEmptyPlan: empty,
    options,
    selectedIndex,
    feedbackFocused: options[selectedIndex]?.kind === 'reject',
    feedback: state.feedback,
    // The secondary button is Escape, exactly: it rejects with *no* feedback.
    // Anything typed into the reject slot's field is submitted by 确认, which is
    // the only place the two differ and the only button in the app that can
    // discard what the user just typed. Making it commit the reject slot instead
    // would be kinder and would answer something the keyboard does not.
    actions: [
      { label: '继续规划', shortcut: 'Esc', role: 'secondary' },
      { label: '确认', shortcut: 'Enter', role: 'primary' },
    ],
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
    return exitPlanIndexToIntent(slot - 1, view)
  }

  if (view.feedbackFocused && event.key.length === 1) {
    return { kind: 'feedback-type', text: event.key }
  }

  return { kind: 'none' }
}

/**
 * A slot to an intent, for both the numeric hotkey and a click on the row.
 *
 * The reject slot **moves** rather than rejecting: that option collects feedback,
 * and answering on the first press would take the field away before anything
 * could be typed into it. A click has to behave the same way, or the feedback
 * field would be unreachable with a mouse.
 */
export function exitPlanIndexToIntent(index: number, view: ExitPlanViewModel): ExitPlanIntent {
  const option = view.options[index]
  if (!option) return { kind: 'none' }
  return option.kind === 'reject'
    ? { kind: 'move', selectedIndex: index }
    : { kind: 'select', selectedIndex: index }
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
