import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OTHER_LABEL,
  applyAskIntent,
  askKeyToIntent,
  askViewModel,
  createAskState,
} from '../src/desktop/renderer/model/askUserQuestion.js'
import type { AskState } from '../src/desktop/renderer/model/askUserQuestion.js'
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../src/harness/types.js'

/**
 * The desktop AskUserQuestion dialog, which used to auto-reject every request.
 *
 * These pin the contract the terminal dialog established: answers keyed by
 * question text, multi-select joined with ", ", an automatic "Other" row that
 * merges with the toggled options, and a two-level Escape.
 */

function request(overrides: Partial<AskUserQuestionRequest['questions'][number]>[] = []): AskUserQuestionRequest {
  return {
    questions: overrides.map((question, index) => ({
      question: question.question ?? `Question ${index + 1}?`,
      header: question.header ?? `H${index + 1}`,
      multiSelect: question.multiSelect ?? false,
      options: question.options ?? [
        { label: 'First', description: 'the first' },
        { label: 'Second', description: 'the second' },
      ],
    })),
  }
}

/** Drives keystrokes through the machine the way the DOM layer will. */
function press(state: AskState, keys: Array<string | { key: string }>): {
  state: AskState
  result: AskUserQuestionResult | undefined
} {
  let current = state
  let result: AskUserQuestionResult | undefined
  for (const raw of keys) {
    const event = typeof raw === 'string' ? { key: raw } : raw
    const outcome = applyAskIntent(current, askKeyToIntent(event, current))
    current = outcome.state
    if ('result' in outcome) result = outcome.result
  }
  return { state: current, result }
}

test('the option list is the declared options plus an automatic Other row', () => {
  const view = askViewModel(createAskState(request([{}])))
  assert.ok(view)
  assert.deepEqual(view.rows.map((row) => row.label), ['First', 'Second', OTHER_LABEL])
  assert.deepEqual(view.rows.map((row) => row.isOther), [false, false, true])
  assert.equal(view.multiSelect, false)
  assert.equal(view.questionTotal, 1)
})

test('a single-select answer resolves with the label, keyed by the question text', () => {
  const { result } = press(createAskState(request([{ question: 'Which one?' }])), ['ArrowDown', 'Enter'])

  assert.deepEqual(result, { kind: 'answers', answers: { 'Which one?': 'Second' } })
})

test('an option preview becomes an annotation, and only when one existed', () => {
  const withPreview = request([{
    question: 'Layout?',
    options: [
      { label: 'A', description: 'a', preview: '+---+' },
      { label: 'B', description: 'b' },
    ],
  }])

  const picked = press(createAskState(withPreview), ['Enter'])
  assert.deepEqual(picked.result, {
    kind: 'answers',
    answers: { 'Layout?': 'A' },
    annotations: { 'Layout?': { preview: '+---+' } },
  })

  const plain = press(createAskState(withPreview), ['ArrowDown', 'Enter'])
  assert.deepEqual(plain.result, { kind: 'answers', answers: { 'Layout?': 'B' } })
  assert.equal('annotations' in (plain.result ?? {}), false)
})

test('multi-select toggles with Space and joins the labels', () => {
  const multi = request([{
    question: 'Which features?',
    multiSelect: true,
    options: [
      { label: 'Alpha', description: 'a' },
      { label: 'Beta', description: 'b' },
      { label: 'Gamma', description: 'g' },
    ],
  }])

  const { result } = press(createAskState(multi), [' ', 'ArrowDown', 'ArrowDown', ' ', 'Enter'])

  assert.deepEqual(result, { kind: 'answers', answers: { 'Which features?': 'Alpha, Gamma' } })
})

test('multi-select Enter with nothing toggled is a single pick', () => {
  const multi = request([{ question: 'Pick?', multiSelect: true }])
  const { result } = press(createAskState(multi), ['ArrowDown', 'Enter'])

  assert.deepEqual(result, { kind: 'answers', answers: { 'Pick?': 'Second' } })
})

test('Other collects free text, and merges it with prior multi-select toggles', () => {
  const multi = request([{ question: 'Which?', multiSelect: true }])
  const toggled = press(createAskState(multi), [' ', 'ArrowDown', 'ArrowDown', 'Enter'])

  const view = askViewModel(toggled.state)
  assert.equal(view?.otherMode, true, 'Enter on Other opens the text field rather than answering')
  assert.equal(toggled.result, undefined)

  const typed = press(toggled.state, ['m', 'i', 'n', 'e', 'Enter'])
  assert.deepEqual(typed.result, { kind: 'answers', answers: { 'Which?': 'First, mine' } })
})

test('Other on a single-select question answers with just the typed text', () => {
  const single = press(createAskState(request([{ question: 'Which?' }])), ['ArrowDown', 'ArrowDown', 'Enter'])
  const typed = press(single.state, ['x', 'y', 'Enter'])

  assert.deepEqual(typed.result, { kind: 'answers', answers: { 'Which?': 'xy' } })
})

test('empty free text is not an answer, and Backspace edits it', () => {
  const opened = press(createAskState(request([{}])), ['ArrowDown', 'ArrowDown', 'Enter'])

  const empty = press(opened.state, ['Enter'])
  assert.equal(empty.result, undefined, 'an empty Other must not resolve')

  const edited = press(opened.state, ['a', 'b', 'Backspace'])
  assert.equal(askViewModel(edited.state)?.otherText, 'a')
})

test('Escape in the text field goes back; Escape in the list rejects', () => {
  const opened = press(createAskState(request([{}])), ['ArrowDown', 'ArrowDown', 'Enter'])
  const backedOut = press(opened.state, ['Escape'])

  assert.equal(backedOut.result, undefined)
  assert.equal(askViewModel(backedOut.state)?.otherMode, false)

  const rejected = press(backedOut.state, ['Escape'])
  assert.deepEqual(rejected.result, { kind: 'rejected' })
})

test('several questions are asked in order and answered together at the end', () => {
  const two = request([
    { question: 'First question?' },
    { question: 'Second question?', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }] },
  ])

  const first = press(createAskState(two), ['Enter'])
  assert.equal(first.result, undefined, 'the request resolves only once')
  const view = askViewModel(first.state)
  assert.equal(view?.question, 'Second question?')
  assert.equal(view?.questionNumber, 2)
  assert.equal(view?.rows[0]?.selected, true, 'per-question state resets')

  const second = press(first.state, ['ArrowDown', 'Enter'])
  assert.deepEqual(second.result, {
    kind: 'answers',
    answers: { 'First question?': 'First', 'Second question?': 'No' },
  })
})

test('Space is inert on a single-select question and on the Other row', () => {
  const single = createAskState(request([{}]))
  assert.deepEqual(askKeyToIntent({ key: ' ' }, single), { kind: 'none' })

  const multi = createAskState(request([{ multiSelect: true }]))
  const onOther = applyAskIntent(multi, { kind: 'move', direction: 'down' }).state
  const onOther2 = applyAskIntent(onOther, { kind: 'move', direction: 'down' }).state
  const toggled = applyAskIntent(onOther2, { kind: 'toggle' })
  assert.deepEqual(toggled.state.toggled, [], 'Other needs text; it cannot be toggled')
})

test('an empty request rejects rather than hanging the tool', () => {
  const outcome = applyAskIntent(createAskState({ questions: [] }), { kind: 'commit' })
  assert.ok('result' in outcome)
  assert.equal(outcome.result.kind, 'rejected')
  assert.equal(askViewModel(createAskState({ questions: [] })), undefined)
})

test('modifier combinations are left to the browser', () => {
  const state = createAskState(request([{}]))
  assert.deepEqual(askKeyToIntent({ key: 'a', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(askKeyToIntent({ key: 'ArrowDown', metaKey: true }, state), { kind: 'none' })
})

// --- the mouse ---------------------------------------------------------------

test('clicking a single-select row answers with that row', () => {
  const state = createAskState(request([{}]))
  const outcome = applyAskIntent(state, { kind: 'select', index: 1 })

  assert.ok('result' in outcome)
  assert.deepEqual(outcome.result, { kind: 'answers', answers: { 'Question 1?': 'Second' } })
})

test('the 提交 button submits a multi-select answer, the way Enter does', () => {
  // The gap S4 left: ticking boxes was reachable with the mouse, committing them
  // was not. The button is a dialog-level action, so it goes through `commit` —
  // the same intent Enter produces, and nothing the keyboard cannot do.
  const state = createAskState(request([{ question: 'Which?', multiSelect: true }]))
  const view = askViewModel(state)
  assert.deepEqual(view?.actions.map((action) => action.role), ['secondary', 'primary'])
  assert.deepEqual(view?.actions.map((action) => action.shortcut), ['Esc', 'Enter'])
  assert.equal(view?.actions[1]?.label, '提交')

  const ticked = applyAskIntent(state, { kind: 'select', index: 1 }).state
  const outcome = applyAskIntent(ticked, { kind: 'commit' })
  assert.ok('result' in outcome)
  assert.deepEqual(outcome.result, { kind: 'answers', answers: { 'Which?': 'Second' } })

  // And the secondary is Escape: it rejects the request rather than the question.
  const cancelled = applyAskIntent(ticked, { kind: 'cancel' })
  assert.ok('result' in cancelled)
  assert.deepEqual(cancelled.result, { kind: 'rejected' })
})

test('the free-text field relabels the buttons rather than growing new ones', () => {
  const state = applyAskIntent(createAskState(request([{ multiSelect: true }])), {
    kind: 'select',
    index: 2,
  }).state
  const view = askViewModel(state)
  // Escape has two levels here, so the secondary says 返回, not 取消.
  assert.deepEqual(view?.actions.map((action) => action.label), ['返回', '提交'])
})

test('clicking a multi-select row ticks it instead of submitting', () => {
  const state = createAskState(request([{ multiSelect: true }]))
  const first = applyAskIntent(state, { kind: 'select', index: 1 })

  assert.ok(!('result' in first), 'the question stays open — the answer is 提交')
  assert.deepEqual(first.state.toggled, [1])
  assert.equal(first.state.selectedIndex, 1, 'and the row is focused, so Enter lands on it')

  // A second click unticks it, exactly as Space does.
  const second = applyAskIntent(first.state, { kind: 'select', index: 1 })
  assert.deepEqual(second.state.toggled, [])
})

test('clicking the Other row opens the text field rather than answering with its label', () => {
  const state = createAskState(request([{ multiSelect: true }]))
  const other = applyAskIntent(state, { kind: 'select', index: 2 })

  assert.ok(!('result' in other))
  assert.equal(other.state.otherMode, true)
  assert.equal(other.state.otherText, '')
  assert.notEqual(OTHER_LABEL, '', 'the row clicked is the automatic one')
})

test('a click is inert while the free-text field is open, and out of range', () => {
  const typing = applyAskIntent(createAskState(request([{}])), { kind: 'select', index: 2 })
  assert.equal(typing.state.otherMode, true)
  const again = applyAskIntent(typing.state, { kind: 'select', index: 0 })
  assert.deepEqual(again.state, typing.state, 'the list is not the target while typing')

  const state = createAskState(request([{}]))
  assert.deepEqual(applyAskIntent(state, { kind: 'select', index: 9 }).state, state)
  assert.deepEqual(applyAskIntent(state, { kind: 'select', index: -1 }).state, state)
})
