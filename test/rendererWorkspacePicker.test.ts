import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkspacePickerState,
  moveWorkspaceSelection,
  workspacePickerKeyToIntent,
  workspacePickerSignature,
  workspacePickerView,
  type WorkspacePickerState,
} from '../src/desktop/renderer/model/workspacePicker.js'

/**
 * The welcome screen's workspace switcher, as decisions.
 *
 * A `model/` test rather than a DOM one on purpose: which rows exist, which one
 * is ticked, whether「不在项目中工作」is offered and what a keystroke means are all
 * answerable without a document — and `dom/workspacePickerView.ts` is then only
 * nodes and events.
 */

function stateOf(overrides: Partial<WorkspacePickerState> = {}): WorkspacePickerState {
  return createWorkspacePickerState({
    open: true,
    options: [
      { projectRoot: '/w/hanekawa', projectName: 'Hanekawa-main', isGlobal: false },
      { projectRoot: '/w/win6', projectName: 'win6', isGlobal: false },
      { projectRoot: '/home/miyano', projectName: '最近', isGlobal: true },
    ],
    currentRoot: '/w/hanekawa',
    globalRoot: '/home/miyano',
    ...overrides,
  })
}

test('the rows are the projects, in wire order, with the current one ticked', () => {
  const view = workspacePickerView(stateOf())

  // The global workspace is deliberately absent: it is the「不在项目中工作」
  // action, and a row for it would be a second way to say the same thing.
  assert.deepEqual(view.rows.map((row) => row.projectName), ['Hanekawa-main', 'win6'])
  assert.deepEqual(view.rows.map((row) => row.current), [true, false])
  assert.equal(view.canLeaveProject, true)
})

test('the search filters by display name, case-insensitively', () => {
  const view = workspacePickerView(stateOf({ query: 'HANE' }))

  assert.deepEqual(view.rows.map((row) => row.projectName), ['Hanekawa-main'])
  assert.equal(view.noMatches, false)
})

test('a query that matches nothing is noMatches, not an empty list of projects', () => {
  const missed = workspacePickerView(stateOf({ query: 'nope' }))
  const empty = workspacePickerView(stateOf({ options: [] }))

  assert.deepEqual([missed.rows.length, missed.noMatches], [0, true])
  // Without a query there is nothing to have missed — the picker simply has no
  // projects yet, and「新建项目」is the answer the view already offers.
  assert.deepEqual([empty.rows.length, empty.noMatches], [0, false])
})

test('the global workspace is not offered as somewhere to go from itself', () => {
  const inGlobal = workspacePickerView(stateOf({ currentRoot: '/home/miyano' }))
  const unknown = workspacePickerView(stateOf({ globalRoot: undefined }))

  assert.equal(inGlobal.canLeaveProject, false)
  // Before the first `list-sessions` answers there is no root key to name, and
  // an action that cannot say where it goes must not be drawn.
  assert.equal(unknown.canLeaveProject, false)
})

test('arrows move the cursor and clamp at both ends', () => {
  let index = -1
  const viewAt = (at: number) => workspacePickerView(stateOf({ selectedIndex: at }))

  index = moveWorkspaceSelection(viewAt(index), 'down')
  assert.equal(index, 0)
  index = moveWorkspaceSelection(viewAt(index), 'down')
  assert.equal(index, 1)
  // Clamped rather than wrapped, the `moveSelection` discipline.
  assert.equal(moveWorkspaceSelection(viewAt(1), 'down'), 1)
  assert.equal(moveWorkspaceSelection(viewAt(0), 'up'), 0)
  // No cursor and "up" means the last row, so the list can be entered backwards.
  assert.equal(moveWorkspaceSelection(viewAt(-1), 'up'), 1)
})

test('an out-of-range cursor is clamped rather than trusted', () => {
  const view = workspacePickerView(stateOf({ selectedIndex: 9 }))

  assert.deepEqual(view.rows.map((row) => row.selected), [false, true])
})

test('Enter picks the row under the cursor, and only reveals the current one', () => {
  const other = workspacePickerView(stateOf({ selectedIndex: 1 }))
  const current = workspacePickerView(stateOf({ selectedIndex: 0 }))

  assert.deepEqual(workspacePickerKeyToIntent({ key: 'Enter' }, other), {
    kind: 'pick',
    projectRoot: '/w/win6',
  })
  // Nothing to open: the pane is already there, so the sidebar answers instead.
  assert.deepEqual(workspacePickerKeyToIntent({ key: 'Enter' }, current), {
    kind: 'reveal',
    projectRoot: '/w/hanekawa',
  })
})

test('Enter with no cursor does nothing — the search box has focus by default', () => {
  const view = workspacePickerView(stateOf())

  assert.deepEqual(workspacePickerKeyToIntent({ key: 'Enter' }, view), { kind: 'none' })
})

test('Escape closes, arrows move, and a modified key falls through', () => {
  const view = workspacePickerView(stateOf())

  assert.deepEqual(workspacePickerKeyToIntent({ key: 'Escape' }, view), { kind: 'close' })
  assert.deepEqual(workspacePickerKeyToIntent({ key: 'ArrowDown' }, view), {
    kind: 'move',
    direction: 'down',
  })
  // Ctrl+T is "new session" everywhere in this window, popover or not.
  assert.deepEqual(workspacePickerKeyToIntent({ key: 't', ctrlKey: true }, view), { kind: 'none' })
})

test('a closed picker consumes no key at all', () => {
  const view = workspacePickerView(stateOf({ open: false }))

  assert.deepEqual(workspacePickerKeyToIntent({ key: 'Escape' }, view), { kind: 'none' })
  assert.deepEqual(workspacePickerKeyToIntent({ key: 'ArrowDown' }, view), { kind: 'none' })
})

test('the signature moves for everything the view draws', () => {
  const base = workspacePickerSignature(workspacePickerView(stateOf()))

  const moved = [
    stateOf({ open: false }),
    stateOf({ query: 'win' }),
    stateOf({ selectedIndex: 0 }),
    stateOf({ currentRoot: '/w/win6' }),
    stateOf({ globalRoot: undefined }),
    stateOf({
      options: [{ projectRoot: '/w/other', projectName: 'other', isGlobal: false }],
    }),
  ]
  for (const state of moved) {
    assert.notEqual(
      workspacePickerSignature(workspacePickerView(state)),
      base,
      JSON.stringify(state),
    )
  }
})
