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
