import assert from 'node:assert/strict'
import test from 'node:test'

import {
  branchPickerKeyToIntent,
  branchPickerSignature,
  branchPickerView,
  createBranchPickerState,
  moveBranchSelection,
  type BranchPickerState,
} from '../src/desktop/renderer/model/branchPicker.js'

/**
 * The empty state's branch switcher, as data.
 *
 * The rules worth pinning are the ones a DOM test cannot see: which key does
 * what while a switch is in flight, and what the render signature has to move
 * on — this popover is drawn from the pane's per-token transcript paint, so an
 * unsigned field is a click the guard swallows.
 */

function stateWith(overrides: Partial<BranchPickerState> = {}): BranchPickerState {
  return createBranchPickerState({
    open: true,
    branches: ['master', 'topic', 'release'],
    current: 'master',
    ...overrides,
  })
}

test('every branch is a row and the checked-out one is marked', () => {
  const view = branchPickerView(stateWith())
  assert.deepEqual(view.rows.map((row) => row.name), ['master', 'topic', 'release'])
  assert.deepEqual(view.rows.map((row) => row.current), [true, false, false])
  assert.equal(view.empty, false)
})

test('an answered but empty list is not the same state as a loading one', () => {
  assert.equal(branchPickerView(stateWith({ branches: [] })).empty, true)
  assert.equal(branchPickerView(stateWith({ branches: [], loading: true })).empty, false)
})

test('the cursor clamps at both ends rather than wrapping', () => {
  const view = branchPickerView(stateWith())
  // No cursor yet: down takes the first row, up the last.
  assert.equal(moveBranchSelection(view, 'down'), 0)
  assert.equal(moveBranchSelection(view, 'up'), 2)

  const atTop = branchPickerView(stateWith({ selectedIndex: 0 }))
  assert.equal(moveBranchSelection(atTop, 'up'), 0)
  const atEnd = branchPickerView(stateWith({ selectedIndex: 2 }))
  assert.equal(moveBranchSelection(atEnd, 'down'), 2)

  assert.equal(moveBranchSelection(branchPickerView(stateWith({ branches: [] })), 'down'), -1)
})

test('a cursor past the end of a shorter list is clamped, not carried', () => {
  const view = branchPickerView(stateWith({ selectedIndex: 9 }))
  assert.deepEqual(view.rows.map((row) => row.selected), [false, false, true])
})

// --- keys --------------------------------------------------------------------

test('the popover only answers keys while it is open', () => {
  assert.deepEqual(
    branchPickerKeyToIntent({ key: 'Escape' }, branchPickerView(stateWith({ open: false }))),
    { kind: 'none' },
  )
})

test('Escape closes, the arrows move, and a modifier is left to the window', () => {
  const view = branchPickerView(stateWith())
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Escape' }, view), { kind: 'close' })
  assert.deepEqual(branchPickerKeyToIntent({ key: 'ArrowDown' }, view), { kind: 'move', direction: 'down' })
  assert.deepEqual(branchPickerKeyToIntent({ key: 'ArrowUp' }, view), { kind: 'move', direction: 'up' })
  assert.deepEqual(branchPickerKeyToIntent({ key: 'ArrowDown', ctrlKey: true }, view), { kind: 'none' })
})

test('Enter with no cursor moves nothing — a stray one must not touch the tree', () => {
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Enter' }, branchPickerView(stateWith())), { kind: 'none' })
})

test('Enter picks the row under the cursor, and only closes on the current branch', () => {
  const onTopic = branchPickerView(stateWith({ selectedIndex: 1 }))
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Enter' }, onTopic), { kind: 'pick', branch: 'topic' })
  const onCurrent = branchPickerView(stateWith({ selectedIndex: 0 }))
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Enter' }, onCurrent), { kind: 'close' })
})

test('a switch in flight swallows every key but Escape', () => {
  const view = branchPickerView(stateWith({ selectedIndex: 1, switching: true }))
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Enter' }, view), { kind: 'none' })
  assert.deepEqual(branchPickerKeyToIntent({ key: 'ArrowDown' }, view), { kind: 'none' })
  // Escape still works, or a switch that hangs would trap the popover open.
  assert.deepEqual(branchPickerKeyToIntent({ key: 'Escape' }, view), { kind: 'close' })
})

// --- the render signature ----------------------------------------------------

const of = (state: BranchPickerState): string => branchPickerSignature(branchPickerView(state))

test('everything the popover draws moves the signature', () => {
  const reference = of(stateWith())
  const mutations: ReadonlyArray<[string, BranchPickerState]> = [
    ['closed', stateWith({ open: false })],
    ['loading', stateWith({ loading: true })],
    ['switching', stateWith({ switching: true })],
    ['error', stateWith({ error: 'dirty worktree' })],
    ['cursor', stateWith({ selectedIndex: 1 })],
    ['branches', stateWith({ branches: ['master'] })],
    ['head moved', stateWith({ current: 'topic' })],
  ]
  for (const [what, state] of mutations) {
    assert.notEqual(of(state), reference, what)
  }
  assert.equal(of(stateWith()), reference)
})
