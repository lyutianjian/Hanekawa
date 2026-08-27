import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_PREVIEW_LINES,
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanIndexToIntent,
  enterPlanKeyToIntent,
  enterPlanViewModel,
  exitPlanIndexToIntent,
  exitPlanKeyToIntent,
  exitPlanViewModel,
} from '../src/desktop/renderer/model/planDialogs.js'
import type { ExitPlanState } from '../src/desktop/renderer/model/planDialogs.js'
import type { ExitDialogInput, ExitPlanDecision } from '../src/harness/planModeManager.js'

/**
 * The desktop plan dialogs, which used to auto-approve entry and auto-reject exit
 * while discarding the plan text entirely.
 */

function input(overrides: Partial<ExitDialogInput> = {}): ExitDialogInput {
  return {
    planContent: '# Plan\n- do the thing',
    planFilePath: '.myagent/plans/plan.md',
    ...overrides,
  }
}

function press(state: ExitPlanState, keys: string[]): {
  state: ExitPlanState
  decision: ExitPlanDecision | undefined
} {
  let current = state
  let decision: ExitPlanDecision | undefined
  for (const key of keys) {
    const outcome = applyExitPlanIntent(current, exitPlanKeyToIntent({ key }, exitPlanViewModel(current)))
    current = outcome.state
    if ('decision' in outcome) decision = outcome.decision
  }
  return { state: current, decision }
}

test('entering plan mode offers two options and explains what will happen', () => {
  const view = enterPlanViewModel()

  assert.equal(view.title, '进入计划模式？')
  assert.deepEqual(view.options.map((option) => option.value), ['yes', 'no'])
  assert.equal(view.selectedIndex, 0)
  assert.ok(view.bullets.length > 0)
  assert.match(view.reassurance, /不会修改任何代码/)
})

test('entry keys move, pick by number, and decline on Escape', () => {
  assert.deepEqual(enterPlanKeyToIntent({ key: 'ArrowDown' }, { selectedIndex: 0 }), { kind: 'move', selectedIndex: 1 })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'ArrowUp' }, { selectedIndex: 1 }), { kind: 'move', selectedIndex: 0 })
  assert.deepEqual(enterPlanKeyToIntent({ key: '1' }, { selectedIndex: 1 }), { kind: 'answer', approved: true })
  assert.deepEqual(enterPlanKeyToIntent({ key: '2' }, { selectedIndex: 0 }), { kind: 'answer', approved: false })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Enter' }, { selectedIndex: 0 }), { kind: 'answer', approved: true })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Enter' }, { selectedIndex: 1 }), { kind: 'answer', approved: false })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Escape' }, { selectedIndex: 0 }), { kind: 'answer', approved: false })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'x' }, { selectedIndex: 0 }), { kind: 'none' })
})

test('exiting shows the plan, its file path and three options', () => {
  const view = exitPlanViewModel(createExitPlanState(input()))

  assert.equal(view.title, '可以开始写代码了吗？')
  assert.match(view.planPreview, /do the thing/)
  assert.equal(view.planFilePath, '.myagent/plans/plan.md')
  assert.deepEqual(view.options.map((option) => option.kind), [
    'approve_acceptEdits_keep',
    'approve_restore_keep',
    'reject',
  ])
  assert.equal(view.isEmptyPlan, false)
  assert.equal(view.feedbackFocused, false)
})

test('bypass replaces the elevated slot when the user opted in', () => {
  const view = exitPlanViewModel(createExitPlanState(input({ isBypassAvailable: true })))
  assert.equal(view.options[0]?.kind, 'approve_bypass_keep')
})

test('an approval carries the plan text', () => {
  const { decision } = press(createExitPlanState(input()), ['ArrowDown', 'Enter'])

  assert.deepEqual(decision, {
    kind: 'approve_restore_keep',
    planContent: '# Plan\n- do the thing',
  })
})

test('rejecting carries whatever feedback was typed', () => {
  // The reject slot is last; moving there turns typing into feedback.
  const moved = press(createExitPlanState(input()), ['3'])
  assert.equal(exitPlanViewModel(moved.state).feedbackFocused, true)
  assert.equal(moved.decision, undefined, 'a numeric hotkey on reject moves rather than rejecting')

  const typed = press(moved.state, ['n', 'o', 't', ' ', 'y', 'e', 't', 'Enter'])
  assert.deepEqual(typed.decision, { kind: 'reject', feedback: 'not yet' })
})

test('Backspace edits feedback only while the reject slot is focused', () => {
  const focused = press(createExitPlanState(input()), ['3', 'a', 'b', 'Backspace'])
  assert.equal(exitPlanViewModel(focused.state).feedback, 'a')

  const onApproval = createExitPlanState(input())
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Backspace' }, exitPlanViewModel(onApproval)), { kind: 'none' })
  // A plain letter on an approval slot is not feedback either.
  assert.deepEqual(exitPlanKeyToIntent({ key: 'z' }, exitPlanViewModel(onApproval)), { kind: 'none' })
})

test('a numeric hotkey on an approval slot resolves immediately', () => {
  const { decision } = press(createExitPlanState(input({ isBypassAvailable: true })), ['1'])
  assert.deepEqual(decision, { kind: 'approve_bypass_keep', planContent: '# Plan\n- do the thing' })
})

test('Escape keeps planning with empty feedback, even mid-typing', () => {
  const { decision } = press(createExitPlanState(input()), ['3', 'w', 'i', 'p', 'Escape'])
  assert.deepEqual(decision, { kind: 'reject', feedback: '' })
})

test('an empty plan gets two options and a different title', () => {
  const view = exitPlanViewModel(createExitPlanState(input({ planContent: '   \n ' })))

  assert.equal(view.title, '退出计划模式？')
  assert.equal(view.isEmptyPlan, true)
  assert.deepEqual(view.options.map((option) => option.kind), ['approve_restore_keep', 'reject'])

  const approved = press(createExitPlanState(input({ planContent: '' })), ['1'])
  assert.equal(approved.decision?.kind, 'approve_restore_keep')
})

test('entering plan mode offers its two options as buttons', () => {
  const view = enterPlanViewModel(0)
  // Slots, so a click resolves through `enterPlanIndexToIntent` — the same
  // function the digits use, reading the same `ENTER_OPTIONS` array.
  assert.deepEqual(view.actions.map((action) => action.slot), [0, 1])
  assert.deepEqual(view.actions.map((action) => action.shortcut), ['1', '2'])
  assert.deepEqual(view.actions.map((action) => action.role), ['primary', 'secondary'])
  assert.deepEqual(view.actions.map((action) => action.label), view.options.map((o) => o.label))
})

test('the exit dialog offers 确认 and 继续规划, and 继续规划 is exactly Escape', () => {
  const state = createExitPlanState(input())
  const view = exitPlanViewModel(state)

  // Dialog-level buttons, not slots: the options stay a row list because the
  // reject slot grows a feedback field.
  assert.deepEqual(view.actions.map((action) => action.slot), [undefined, undefined])
  assert.deepEqual(view.actions.map((action) => action.role), ['secondary', 'primary'])
  assert.deepEqual(view.actions.map((action) => action.shortcut), ['Esc', 'Enter'])

  // The secondary answers what its badge says, discarding a typed feedback the
  // same way Escape does. That equality is the claim; it is the one button in
  // the app that can throw away typing, and `planDialogs.ts` says why.
  const typed = press(state, ['3', 'w', 'i', 'p']).state
  const byButton = applyExitPlanIntent(typed, { kind: 'reject' })
  const byEscape = applyExitPlanIntent(typed, exitPlanKeyToIntent({ key: 'Escape' }, exitPlanViewModel(typed)))
  assert.deepEqual(
    'decision' in byButton ? byButton.decision : undefined,
    'decision' in byEscape ? byEscape.decision : undefined,
  )

  // 确认 is Enter, which *does* carry the feedback.
  const byPrimary = applyExitPlanIntent(typed, { kind: 'commit' })
  assert.deepEqual(
    'decision' in byPrimary ? byPrimary.decision : undefined,
    { kind: 'reject', feedback: 'wip' },
  )
})

test('a long plan is previewed with the middle collapsed', () => {
  const long = Array.from({ length: PLAN_PREVIEW_LINES + 30 }, (_, i) => `step ${i + 1}`).join('\n')
  const view = exitPlanViewModel(createExitPlanState(input({ planContent: long })))

  assert.equal(view.planPreview.split('\n').length, PLAN_PREVIEW_LINES)
  assert.match(view.planPreview, /预览中省略/)
  assert.match(view.planPreview, /step 1/)
  assert.match(view.planPreview, new RegExp(`step ${PLAN_PREVIEW_LINES + 30}`))
})

test('movement is bounded, not wrapping', () => {
  const state = createExitPlanState(input())
  assert.deepEqual(exitPlanKeyToIntent({ key: 'ArrowUp' }, exitPlanViewModel(state)), { kind: 'move', selectedIndex: 0 })

  const atEnd = press(state, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown'])
  assert.equal(exitPlanViewModel(atEnd.state).selectedIndex, 2)
})

// --- the mouse ---------------------------------------------------------------

test('clicking an entry option answers what its number key answers', () => {
  const view = enterPlanViewModel(0)
  view.options.forEach((option, index) => {
    const clicked = enterPlanIndexToIntent(index)
    const typed = enterPlanKeyToIntent({ key: option.hotkey }, { selectedIndex: 0 })
    assert.deepEqual(clicked, typed, `slot ${index} agrees between mouse and keyboard`)
    assert.deepEqual(clicked, { kind: 'answer', approved: option.value === 'yes' })
  })
  assert.deepEqual(enterPlanIndexToIntent(9), { kind: 'none' })
})

test('clicking the reject slot moves to it, so the feedback field can be typed into', () => {
  const view = exitPlanViewModel(createExitPlanState(input()))
  const rejectIndex = view.options.findIndex((option) => option.kind === 'reject')
  assert.ok(rejectIndex >= 0)

  const intent = exitPlanIndexToIntent(rejectIndex, view)
  assert.deepEqual(intent, { kind: 'move', selectedIndex: rejectIndex })
  const outcome = applyExitPlanIntent(createExitPlanState(input()), intent)
  assert.ok(!('decision' in outcome), 'a click there does not reject outright')
  assert.equal(exitPlanViewModel(outcome.state).feedbackFocused, true)
})

test('clicking any other exit option decides, and matches its number key', () => {
  const view = exitPlanViewModel(createExitPlanState(input({ isBypassAvailable: true })))
  view.options.forEach((option, index) => {
    const clicked = exitPlanIndexToIntent(index, view)
    const typed = exitPlanKeyToIntent({ key: String(index + 1) }, view)
    assert.deepEqual(clicked, typed, `slot ${index + 1} agrees between mouse and keyboard`)
    if (option.kind === 'reject') return
    const outcome = applyExitPlanIntent(createExitPlanState(input({ isBypassAvailable: true })), clicked)
    assert.ok('decision' in outcome && outcome.decision.kind === option.kind)
  })
  assert.deepEqual(exitPlanIndexToIntent(view.options.length, view), { kind: 'none' })
})
