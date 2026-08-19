import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTabBarState,
  findClose,
  findSwitch,
  tabBarKeyToIntent,
  tabBarView,
  type TabBarState,
} from '../src/desktop/renderer/model/tabBar.js'
import type { WirePaneInfo } from '../src/runtime/protocol/wire.js'

/**
 * Pure-function coverage for the tab bar model. Mirrors the model-only tests
 * for `transcript.ts`, `uiQueue.ts`, etc.: a `model/` module is compiled in
 * the base tsconfig program (no DOM lib), so the tests here run with the
 * same shape the renderer ships.
 */

function pane(overrides: Partial<WirePaneInfo> = {}): WirePaneInfo {
  const result: WirePaneInfo = {
    paneId: overrides.paneId ?? 'pane-1',
    sessionId: overrides.sessionId ?? 's1',
    projectRoot: overrides.projectRoot ?? OWN_ROOT,
    projectName: overrides.projectName ?? 'own',
  }
  if (overrides.sessionTitle !== undefined) result.sessionTitle = overrides.sessionTitle
  return result
}

/**
 * The default helper builds panes in `OWN_ROOT`, and `stateWith` leaves
 * `ownProjectRoot` unset — which the model reads as "everything is mine". The
 * cross-project cases below pass it explicitly.
 */
const OWN_ROOT = 'c:/repo/own'
const OTHER_ROOT = 'c:/repo/other'

function stateWith(panes: WirePaneInfo[], activePaneId?: string): TabBarState {
  return createTabBarState(panes, activePaneId)
}

function stateAcross(panes: WirePaneInfo[], activePaneId?: string): TabBarState {
  return createTabBarState(panes, activePaneId, OWN_ROOT)
}

test('tabBarView produces one row per pane, marking the active one', () => {
  const panes = [pane({ paneId: 'a', sessionTitle: 'Alpha' }), pane({ paneId: 'b', sessionTitle: 'Bravo' })]
  const view = tabBarView(stateWith(panes, 'b'))

  assert.equal(view.rows.length, 2)
  assert.deepEqual(view.rows.map((row) => row.paneId), ['a', 'b'])
  assert.equal(view.rows[0]?.active, false)
  assert.equal(view.rows[1]?.active, true)
  assert.equal(view.activePaneId, 'b')
  assert.equal(view.hasNewTab, true)
})

test('a pane without a title falls back to "Untitled"', () => {
  // The helper defaults sessionTitle to 'Tab', so pass `undefined` explicitly
  // to exercise the "no title" path.
  const view = tabBarView(stateWith([pane({ paneId: 'a', sessionTitle: undefined })]))
  assert.equal(view.rows[0]?.title, 'Untitled')
})

test('canCreate=false hides the "+" button', () => {
  const view = tabBarView({ panes: [], activePaneId: undefined, canCreate: false })
  assert.equal(view.hasNewTab, false)
})

test('a row in this window\'s own project is closable', () => {
  const view = tabBarView(stateWith([pane({ paneId: 'a' })]))
  assert.equal(view.rows[0]?.closable, true)
})

test('Ctrl+T maps to "new", Ctrl+W maps to "close active", Ctrl+1 maps to "switch first"', () => {
  const state = stateWith(
    [pane({ paneId: 'a' }), pane({ paneId: 'b' }), pane({ paneId: 'c' })],
    'b',
  )

  assert.deepEqual(tabBarKeyToIntent({ key: 't', ctrlKey: true }, state), { kind: 'new' })
  assert.deepEqual(tabBarKeyToIntent({ key: 'T', ctrlKey: true }, state), { kind: 'new' })
  assert.deepEqual(tabBarKeyToIntent({ key: 't', metaKey: true }, state), { kind: 'new' })

  assert.deepEqual(
    tabBarKeyToIntent({ key: 'w', ctrlKey: true }, state),
    { kind: 'close', paneId: 'b' },
  )

  assert.deepEqual(
    tabBarKeyToIntent({ key: '1', ctrlKey: true }, state),
    { kind: 'switch', paneId: 'a' },
  )
  assert.deepEqual(
    tabBarKeyToIntent({ key: '3', metaKey: true }, state),
    { kind: 'switch', paneId: 'c' },
  )
})

test('Ctrl+9 on a small list returns "none" instead of indexing past the end', () => {
  const state = stateWith([pane({ paneId: 'a' })])
  assert.deepEqual(tabBarKeyToIntent({ key: '9', ctrlKey: true }, state), { kind: 'none' })
})

test('Ctrl+W without an active pane is a no-op', () => {
  const state = stateWith([pane({ paneId: 'a' })])
  assert.deepEqual(tabBarKeyToIntent({ key: 'w', ctrlKey: true }, state), { kind: 'none' })
})

test('plain keystrokes without a modifier are not tab-bar intents', () => {
  const state = stateWith([pane({ paneId: 'a' })])
  assert.deepEqual(tabBarKeyToIntent({ key: 't' }, state), { kind: 'none' })
  assert.deepEqual(tabBarKeyToIntent({ key: '1' }, state), { kind: 'none' })
})

test('findSwitch returns "none" for an unknown pane id, "switch" otherwise', () => {
  const state = stateWith([pane({ paneId: 'a' }), pane({ paneId: 'b' })])
  assert.deepEqual(findSwitch(state, 'a'), { kind: 'switch', paneId: 'a' })
  assert.deepEqual(findSwitch(state, 'ghost'), { kind: 'none' })
})

test('findClose mirrors findSwitch, also returning "none" on unknown ids', () => {
  const state = stateWith([pane({ paneId: 'a' })])
  assert.deepEqual(findClose(state, 'a'), { kind: 'close', paneId: 'a' })
  assert.deepEqual(findClose(state, 'ghost'), { kind: 'none' })
})

test('the default state is empty and harmless', () => {
  const view = tabBarView(createTabBarState())
  assert.equal(view.rows.length, 0)
  assert.equal(view.activePaneId, undefined)
  assert.equal(view.hasNewTab, true)
  // The hint is constant today; pinning the string here so a typo breaks the
  // test rather than the renderer.
  assert.match(view.hint, /Ctrl\+T/)
  assert.match(view.hint, /Ctrl\+W/)
})

test('row.paneId matches WirePaneInfo.paneId, never the session id', () => {
  // The paneId is the host's token; a renderer that confuses it with the
  // session id would lose its close button on sessions without a title.
  const view = tabBarView(stateWith([pane({ paneId: 'token-1', sessionId: 'real-session' })]))
  assert.equal(view.rows[0]?.paneId, 'token-1')
  assert.equal(view.rows[0]?.sessionId, 'real-session')
})

// --- several projects in one bar ---------------------------------------------

test('panes are grouped by project, this window\'s own project first', () => {
  // Wire order is "the order projects were opened", so a window belonging to the
  // second project would otherwise find its own tabs in the middle of the bar.
  const view = tabBarView(
    stateAcross([
      pane({ paneId: 'x1', projectRoot: OTHER_ROOT, projectName: 'other' }),
      pane({ paneId: 'a1', projectRoot: OWN_ROOT, projectName: 'own' }),
      pane({ paneId: 'x2', projectRoot: OTHER_ROOT, projectName: 'other' }),
      pane({ paneId: 'a2', projectRoot: OWN_ROOT, projectName: 'own' }),
    ]),
  )

  assert.deepEqual(view.groups.map((group) => group.projectName), ['own', 'other'])
  assert.deepEqual(view.groups.map((group) => group.own), [true, false])
  // Within a project the host's order stands.
  assert.deepEqual(view.groups[0]?.rows.map((row) => row.paneId), ['a1', 'a2'])
  assert.deepEqual(view.groups[1]?.rows.map((row) => row.paneId), ['x1', 'x2'])
  // `rows` is the flattened visual order, which is what the digit chords index.
  assert.deepEqual(view.rows.map((row) => row.paneId), ['a1', 'a2', 'x1', 'x2'])
})

test('project labels appear only from the second project up', () => {
  const single = tabBarView(stateAcross([pane({ paneId: 'a' })]))
  assert.equal(single.showProjectLabels, false)

  const across = tabBarView(
    stateAcross([pane({ paneId: 'a' }), pane({ paneId: 'x', projectRoot: OTHER_ROOT, projectName: 'other' })]),
  )
  assert.equal(across.showProjectLabels, true)
})

test('another project\'s row is focus-only: not closable, and findClose refuses it', () => {
  // Its pane lives in another `SessionWorkspace`, which this window's host
  // cannot close -- and before `focus-pane` existed, asking it to would have
  // destroyed this window instead.
  const state = stateAcross([
    pane({ paneId: 'a' }),
    pane({ paneId: 'x', projectRoot: OTHER_ROOT, projectName: 'other' }),
  ])
  const view = tabBarView(state)

  assert.equal(view.rows.find((row) => row.paneId === 'a')?.closable, true)
  assert.equal(view.rows.find((row) => row.paneId === 'x')?.closable, false)
  assert.deepEqual(findClose(state, 'x'), { kind: 'none' })
  // Focusing it is fine -- that is the whole point of listing it.
  assert.deepEqual(findSwitch(state, 'x'), { kind: 'switch', paneId: 'x' })
})

test('Ctrl+1-9 index the visible order, not the wire order', () => {
  const state = stateAcross([
    pane({ paneId: 'x1', projectRoot: OTHER_ROOT, projectName: 'other' }),
    pane({ paneId: 'a1', projectRoot: OWN_ROOT }),
  ])
  // Wire index 0 is the foreign pane; on screen it is second.
  assert.deepEqual(tabBarKeyToIntent({ key: '1', ctrlKey: true }, state), { kind: 'switch', paneId: 'a1' })
  assert.deepEqual(tabBarKeyToIntent({ key: '2', ctrlKey: true }, state), { kind: 'switch', paneId: 'x1' })
})

test('Ctrl+W refuses to close another project\'s pane', () => {
  // Reachable if the host reports a foreign pane as this window's session --
  // which should not happen, but the chord must not act on it if it does.
  const state = stateAcross(
    [pane({ paneId: 'x', projectRoot: OTHER_ROOT, projectName: 'other' })],
    'x',
  )
  assert.deepEqual(tabBarKeyToIntent({ key: 'w', ctrlKey: true }, state), { kind: 'none' })
})

test('Ctrl+Shift+O opens a project; Ctrl+O alone does nothing', () => {
  const state = stateWith([pane({ paneId: 'a' })], 'a')
  // A browser reports the shifted letter, so both cases have to map.
  assert.deepEqual(tabBarKeyToIntent({ key: 'O', ctrlKey: true, shiftKey: true }, state), { kind: 'open-project' })
  assert.deepEqual(tabBarKeyToIntent({ key: 'o', ctrlKey: true, shiftKey: true }, state), { kind: 'open-project' })
  assert.deepEqual(tabBarKeyToIntent({ key: 'o', metaKey: true, shiftKey: true }, state), { kind: 'open-project' })
  assert.deepEqual(tabBarKeyToIntent({ key: 'o', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(tabBarKeyToIntent({ key: 'O', shiftKey: true }, state), { kind: 'none' })
})

test('before hello, with no own project known, every row stays closable', () => {
  // `ownProjectRoot` is undefined until `hello()` resolves; at that point the
  // only pane in the list is this window's own.
  const state = stateWith([pane({ paneId: 'a', projectRoot: OTHER_ROOT })], 'a')
  assert.equal(tabBarView(state).rows[0]?.closable, true)
  assert.deepEqual(tabBarKeyToIntent({ key: 'w', ctrlKey: true }, state), { kind: 'close', paneId: 'a' })
})

test('canCreate=false hides both action buttons', () => {
  // Same gate for "+" and "Open project…": both open something, and both are
  // wrong while a blocking dialog is up.
  const view = tabBarView({ panes: [], activePaneId: undefined, canCreate: false })
  assert.equal(view.hasNewTab, false)
  assert.equal(view.hasOpenProject, false)
})

test('the hint names the open-project chord', () => {
  assert.match(tabBarView(createTabBarState()).hint, /Ctrl\+Shift\+O/)
})
