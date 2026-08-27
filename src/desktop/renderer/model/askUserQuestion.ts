import type {
  AskUserQuestionAnnotations,
  AskUserQuestionAnswers,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../../harness/types.js'
import type { DialogAction } from './dialogActions.js'

/**
 * The AskUserQuestion dialog as a state machine.
 *
 * Mirrors `src/tui/components/AskUserQuestionDialog.tsx` decision for decision,
 * because the tool's contract is the same on both shells: 1–4 questions asked one
 * at a time, 2–4 declared options plus an automatic "Other" free-text row,
 * multi-select answers joined with ", ", answers keyed by the *question text*,
 * and Escape rejecting the whole request rather than skipping a question.
 *
 * The shipped desktop renderer auto-rejected every request, so this is the first
 * time the tool is usable there at all.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export const OTHER_LABEL = '其他'

export interface AskState {
  readonly request: AskUserQuestionRequest
  readonly questionIndex: number
  readonly selectedIndex: number
  /** Indices of toggled options; only meaningful for a multi-select question. */
  readonly toggled: readonly number[]
  readonly otherMode: boolean
  readonly otherText: string
  readonly answers: AskUserQuestionAnswers
  readonly annotations: AskUserQuestionAnnotations
}

export interface AskOptionRow {
  readonly label: string
  readonly description: string
  readonly isOther: boolean
  readonly selected: boolean
  readonly toggled: boolean
  readonly preview: string | undefined
}

export interface AskViewModel {
  readonly header: string
  readonly question: string
  readonly questionNumber: number
  readonly questionTotal: number
  readonly multiSelect: boolean
  readonly rows: readonly AskOptionRow[]
  readonly otherMode: boolean
  readonly otherText: string
  /** The focused option's preview, for the side-by-side layout. */
  readonly preview: string | undefined
  /** Dialog-level buttons; the options themselves stay a row list. */
  readonly actions: readonly DialogAction[]
}

export function createAskState(request: AskUserQuestionRequest): AskState {
  return {
    request,
    questionIndex: 0,
    selectedIndex: 0,
    toggled: [],
    otherMode: false,
    otherText: '',
    answers: {},
    annotations: {},
  }
}

export type AskIntent =
  | { kind: 'move'; direction: 'up' | 'down' }
  /** A row was picked outright — the mouse's only intent. See `applyAskIntent`. */
  | { kind: 'select'; index: number }
  | { kind: 'toggle' }
  | { kind: 'commit' }
  | { kind: 'other-type'; text: string }
  | { kind: 'other-backspace' }
  | { kind: 'cancel' }
  | { kind: 'none' }

/**
 * Structural key shape rather than `KeyboardEvent` — this module is imported by
 * a test, which compiles it without the DOM lib.
 */
export function askKeyToIntent(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean },
  state: AskState,
): AskIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }

  if (state.otherMode) {
    if (event.key === 'Escape') return { kind: 'cancel' }
    if (event.key === 'Enter') return { kind: 'commit' }
    if (event.key === 'Backspace') return { kind: 'other-backspace' }
    // A printable character; anything longer is a named key we do not handle.
    if (event.key.length === 1) return { kind: 'other-type', text: event.key }
    return { kind: 'none' }
  }

  switch (event.key) {
    case 'Escape':
      return { kind: 'cancel' }
    case 'ArrowUp':
      return { kind: 'move', direction: 'up' }
    case 'ArrowDown':
      return { kind: 'move', direction: 'down' }
    case 'Enter':
      return { kind: 'commit' }
    case ' ':
      return currentQuestion(state)?.multiSelect === true ? { kind: 'toggle' } : { kind: 'none' }
    default:
      return { kind: 'none' }
  }
}

export type AskOutcome =
  | { readonly state: AskState }
  | { readonly state: AskState; readonly result: AskUserQuestionResult }

/**
 * Applies an intent, answering the request once the last question is committed.
 *
 * In `otherMode`, Escape backs out of the text field rather than rejecting the
 * request — the same two-level Escape the terminal dialog has.
 */
export function applyAskIntent(state: AskState, intent: AskIntent): AskOutcome {
  const question = currentQuestion(state)
  if (!question) {
    // An empty request cannot be answered; rejecting is the only honest reply.
    return { state, result: { kind: 'rejected', feedback: '没有提出任何问题。' } }
  }
  const labels = optionLabels(question)

  switch (intent.kind) {
    case 'move': {
      const delta = intent.direction === 'up' ? -1 : 1
      const next = clamp(state.selectedIndex + delta, 0, labels.length - 1)
      return { state: { ...state, selectedIndex: next } }
    }

    // A click on a row: focus it, then do to it what the keyboard would.
    //
    // Which key that is depends on the row: Space on a multi-select option (so a
    // click ticks the box and the question stays open — the submit affordance is
    // still Enter until the dialog grows buttons), Enter on anything else, which
    // is what routes 「其他」 into `otherMode` rather than answering with its label.
    // While the free-text field is open the list is not the target at all.
    case 'select': {
      if (state.otherMode) return { state }
      if (intent.index < 0 || intent.index >= labels.length) return { state }
      const focused: AskState = { ...state, selectedIndex: intent.index }
      return question.multiSelect === true && !isOtherIndex(intent.index, labels)
        ? applyAskIntent(focused, { kind: 'toggle' })
        : commit(focused, question, labels)
    }

    case 'toggle': {
      // "Other" is not toggleable: it needs text, so Enter routes there instead
      // and whatever is typed is merged with the toggled options.
      if (isOtherIndex(state.selectedIndex, labels)) return { state }
      const toggled = state.toggled.includes(state.selectedIndex)
        ? state.toggled.filter((index) => index !== state.selectedIndex)
        : [...state.toggled, state.selectedIndex]
      return { state: { ...state, toggled } }
    }

    case 'other-type':
      return { state: { ...state, otherText: state.otherText + intent.text } }

    case 'other-backspace':
      return { state: { ...state, otherText: state.otherText.slice(0, -1) } }

    case 'cancel':
      if (state.otherMode) return { state: { ...state, otherMode: false, otherText: '' } }
      return { state, result: { kind: 'rejected' } }

    case 'commit':
      return commit(state, question, labels)

    case 'none':
      return { state }
  }

  return assertNever(intent)
}

function commit(state: AskState, question: AskUserQuestionItem, labels: string[]): AskOutcome {
  if (state.otherMode) {
    const trimmed = state.otherText.trim()
    // An empty free-text answer is not an answer; stay in the field.
    if (trimmed.length === 0) return { state }
    const merged = question.multiSelect && state.toggled.length > 0
      ? [...selectedLabels(state.toggled, labels), trimmed].join(', ')
      : trimmed
    return answer(state, question, merged)
  }

  if (isOtherIndex(state.selectedIndex, labels)) {
    return { state: { ...state, otherMode: true, otherText: '' } }
  }

  if (question.multiSelect) {
    // Enter with nothing toggled is a single pick, so a plain multi-select
    // question still works without discovering Space.
    const indices = state.toggled.length > 0 ? state.toggled : [state.selectedIndex]
    const picked = selectedLabels(indices, labels)
    if (picked.length === 0) return { state }
    return answer(state, question, picked.join(', '))
  }

  const label = labels[state.selectedIndex]
  if (label === undefined) return { state }
  const preview = question.options[state.selectedIndex]?.preview
  return answer(state, question, label, preview ? { preview } : undefined)
}

function answer(
  state: AskState,
  question: AskUserQuestionItem,
  value: string,
  annotation?: AskUserQuestionAnnotations[string],
): AskOutcome {
  // Keyed by the question text, which is what the tool's caller reads back.
  const answers = { ...state.answers, [question.question]: value }
  const annotations = annotation
    ? { ...state.annotations, [question.question]: annotation }
    : state.annotations

  const nextIndex = state.questionIndex + 1
  const next: AskState = {
    ...state,
    answers,
    annotations,
    questionIndex: nextIndex,
    // Per-question state resets, exactly as the terminal dialog's effect does.
    selectedIndex: 0,
    toggled: [],
    otherMode: false,
    otherText: '',
  }

  if (nextIndex < state.request.questions.length) return { state: next }

  return {
    state: next,
    result: {
      kind: 'answers',
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  }
}

export function askViewModel(state: AskState): AskViewModel | undefined {
  const question = currentQuestion(state)
  if (!question) return undefined
  const labels = optionLabels(question)

  return {
    header: question.header,
    question: question.question,
    questionNumber: state.questionIndex + 1,
    questionTotal: state.request.questions.length,
    multiSelect: question.multiSelect === true,
    rows: labels.map((label, index) => ({
      label,
      description: question.options[index]?.description ?? '',
      isOther: isOtherIndex(index, labels),
      selected: index === state.selectedIndex,
      toggled: state.toggled.includes(index),
      preview: question.options[index]?.preview,
    })),
    otherMode: state.otherMode,
    otherText: state.otherText,
    preview: question.multiSelect === true
      ? undefined
      : question.options[state.selectedIndex]?.preview,
    // The submit button is the multi-select answer: ticking boxes with the mouse
    // was reachable before it, but committing them was not (Enter only).
    // Escape's two levels are preserved — in the free-text field it backs out,
    // in the list it rejects the request.
    actions: [
      {
        label: state.otherMode ? '返回' : '取消',
        shortcut: 'Esc',
        role: 'secondary',
      },
      {
        label: state.otherMode || question.multiSelect === true ? '提交' : '选择',
        shortcut: 'Enter',
        role: 'primary',
      },
    ],
  }
}

export function currentQuestion(state: AskState): AskUserQuestionItem | undefined {
  return state.request.questions[state.questionIndex]
}

/** Declared options plus the automatic "Other" row, which is always last. */
export function optionLabels(question: AskUserQuestionItem): string[] {
  return [...question.options.map((option) => option.label), OTHER_LABEL]
}

function isOtherIndex(index: number, labels: readonly string[]): boolean {
  return index === labels.length - 1
}

function selectedLabels(indices: readonly number[], labels: readonly string[]): string[] {
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => labels[index])
    .filter((label): label is string => typeof label === 'string')
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  return value > max ? max : value
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ask intent: ${JSON.stringify(value)}`)
}
