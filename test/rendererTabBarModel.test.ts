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
  }
  if (overrides.sessionTitle !== undefined) result.sessionTitle = overrides.sessionTitle
  return result
}

function stateWith(panes: WirePaneInfo[], activePaneId?: string): TabBarState {
  return createTabBarState(panes, activePaneId)
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

test('every row is closable today; a future "pinned" flag lives on the row', () => {
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