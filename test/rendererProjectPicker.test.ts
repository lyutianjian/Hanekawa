import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canSwitchProject,
  createProjectPickerState,
  moveProjectSelection,
  projectPickerKeyToIntent,
  projectPickerSignature,
  projectPickerView,
  type ProjectPickerState,
} from '../src/desktop/renderer/model/projectPicker.js'

/**
 * The empty state's project switcher, as data.
 *
 * The rules worth pinning are the ones a DOM test cannot see: which key does
 * what, when the pill is a control at all, and what the render signature has to
 * move on — this popover is drawn from the pane's per-token transcript paint, so
 * an unsigned field is a click the guard swallows.
 */

function stateWith(overrides: Partial<ProjectPickerState> = {}): ProjectPickerState {
  return createProjectPickerState({
    open: true,
    projects: [
      { root: '/repos/hanekawa', name: 'Hanekawa-main' },
      { root: '/repos/side', name: 'side' },
    ],
    current: '/repos/hanekawa',
    ...overrides,
  })
}

test('every added project is a row and the current one is marked', () => {
  const view = projectPickerView(stateWith())
  assert.deepEqual(view.rows.map((row) => row.name), ['Hanekawa-main', 'side'])
  assert.deepEqual(view.rows.map((row) => row.current), [true, false])
  assert.equal(view.empty, false)
})

test('the pill is a control only when some row is not the current project', () => {
  assert.equal(canSwitchProject(stateWith()), true)
  // The global workspace: no row is current, and every one of them is somewhere
  // to go.
  assert.equal(canSwitchProject(stateWith({ current: undefined })), true)
  const alone = stateWith({ projects: [{ root: '/repos/hanekawa', name: 'Hanekawa-main' }] })
  assert.equal(canSwitchProject(alone), false)
  assert.equal(canSwitchProject(stateWith({ projects: [] })), false)
  assert.equal(projectPickerView(stateWith({ projects: [] })).empty, true)
})

test('the cursor clamps at both ends rather than wrapping', () => {
  const view = projectPickerView(stateWith())
  assert.equal(moveProjectSelection(view, 'down'), 0)
  assert.equal(moveProjectSelection(projectPickerView(stateWith({ selectedIndex: 0 })), 'up'), 0)
  assert.equal(moveProjectSelection(projectPickerView(stateWith({ selectedIndex: 1 })), 'down'), 1)
  assert.equal(moveProjectSelection(projectPickerView(stateWith({ projects: [] })), 'down'), -1)
})

test('a stale cursor is clamped to the rows that are left', () => {
  // A project can be removed while the popover is open; the cursor must not
  // point past the list.
  const view = projectPickerView(stateWith({ selectedIndex: 7 }))
  assert.deepEqual(view.rows.map((row) => row.selected), [false, true])
})

test('the keys only apply while the popover is open, and never with a modifier', () => {
  const closed = projectPickerView(stateWith({ open: false }))
  assert.deepEqual(projectPickerKeyToIntent({ key: 'Escape' }, closed), { kind: 'none' })
  const view = projectPickerView(stateWith())
  assert.deepEqual(projectPickerKeyToIntent({ key: 'Escape', ctrlKey: true }, view), { kind: 'none' })
  assert.deepEqual(projectPickerKeyToIntent({ key: 'Escape' }, view), { kind: 'close' })
  assert.deepEqual(projectPickerKeyToIntent({ key: 'ArrowDown' }, view), { kind: 'move', direction: 'down' })
})

test('Enter picks the row under the cursor, and only closes on the current one', () => {
  // A stray Enter with no cursor must not move the window into another project.
  assert.deepEqual(projectPickerKeyToIntent({ key: 'Enter' }, projectPickerView(stateWith())), { kind: 'none' })
  assert.deepEqual(
    projectPickerKeyToIntent({ key: 'Enter' }, projectPickerView(stateWith({ selectedIndex: 1 }))),
    { kind: 'pick', root: '/repos/side' },
  )
  assert.deepEqual(
    projectPickerKeyToIntent({ key: 'Enter' }, projectPickerView(stateWith({ selectedIndex: 0 }))),
    { kind: 'close' },
  )
})

test('everything the popover draws moves the signature', () => {
  const of = (state: ProjectPickerState): string => projectPickerSignature(projectPickerView(state))
  const reference = of(stateWith())
  assert.equal(of(stateWith()), reference)
  const mutations: ReadonlyArray<[string, ProjectPickerState]> = [
    ['closed', stateWith({ open: false })],
    ['cursor', stateWith({ selectedIndex: 1 })],
    ['which is current', stateWith({ current: '/repos/side' })],
    ['a project added', stateWith({ projects: [...stateWith().projects, { root: '/repos/third', name: 'third' }] })],
    ['renamed', stateWith({ projects: [{ root: '/repos/hanekawa', name: 'renamed' }] })],
  ]
  for (const [what, state] of mutations) assert.notEqual(of(state), reference, what)
})
