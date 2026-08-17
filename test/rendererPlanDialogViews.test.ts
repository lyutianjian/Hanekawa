import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_PREVIEW_LINES,
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanKeyToIntent,
  enterPlanViewModel,
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

  assert.equal(view.title, 'Enter plan mode?')
  assert.deepEqual(view.options.map((option) => option.value), ['yes', 'no'])
  assert.equal(view.selectedIndex, 0)
  assert.ok(view.bullets.length > 0)
  assert.match(view.reassurance, /No code changes/)
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

  assert.equal(view.title, 'Ready to code?')
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

  assert.equal(view.title, 'Exit plan mode?')
  assert.equal(view.isEmptyPlan, true)
  assert.deepEqual(view.options.map((option) => option.kind), ['approve_restore_keep', 'reject'])
  assert.match(view.hint, /\[1-2\] Quick/)

  const approved = press(createExitPlanState(input({ planContent: '' })), ['1'])
  assert.equal(approved.decision?.kind, 'approve_restore_keep')
})

test('a long plan is previewed with the middle collapsed', () => {
  const long = Array.from({ length: PLAN_PREVIEW_LINES + 30 }, (_, i) => `step ${i + 1}`).join('\n')
  const view = exitPlanViewModel(createExitPlanState(input({ planContent: long })))

  assert.equal(view.planPreview.split('\n').length, PLAN_PREVIEW_LINES)
  assert.match(view.planPreview, /lines omitted from preview/)
  assert.match(view.planPreview, /step 1/)
  assert.match(view.planPreview, new RegExp(`step ${PLAN_PREVIEW_LINES + 30}`))
})

test('movement is bounded, not wrapping', () => {
  const state = createExitPlanState(input())
  assert.deepEqual(exitPlanKeyToIntent({ key: 'ArrowUp' }, exitPlanViewModel(state)), { kind: 'move', selectedIndex: 0 })

  const atEnd = press(state, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown'])
  assert.equal(exitPlanViewModel(atEnd.state).selectedIndex, 2)
})
