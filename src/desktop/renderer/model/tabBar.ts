import type { WirePaneInfo } from '../../../runtime/protocol/wire.js'

/**
 * The tab bar as data.
 *
 * Renderer tabs are a small slate: a list of `WirePaneInfo` rows, the currently
 * focused one, and a layout-true row per tab. Everything DOM-shaped (class
 * names, click handlers) lives in `dom/tabBarView.ts`; this file is the one a
 * test can drive without jsdom, and the one the keymap reaches for when a
 * keystroke arrives over the global handler.
 *
 * DOM-free on purpose, for the same reason the other model modules are: a
 * `model/` module imported by a test is compiled in the base tsconfig program,
 * which has no DOM lib. The shape is `{ key, shiftKey, ctrlKey, metaKey }`,
 * never `KeyboardEvent`.
 */

export interface TabRow {
  readonly paneId: string
  readonly sessionId: string
  readonly title: string
  readonly active: boolean
  readonly closable: boolean
}

export interface TabBarView {
  readonly panes: readonly WirePaneInfo[]
  readonly rows: readonly TabRow[]
  readonly activePaneId: string | undefined
  /** Hint shown in the status bar; mirrors the keymap. */
  readonly hint: string
  readonly hasNewTab: boolean
}

export interface TabBarState {
  /** The full set of open panes, in display order. */
  readonly panes: readonly WirePaneInfo[]
  /** The pane that owns the focused window. May be absent on startup. */
  readonly activePaneId: string | undefined
  /** Whether the "+" button should be drawn. False while an overlay is open. */
  readonly canCreate: boolean
}

/**
 * Static cols, kept as a default for tests that don't want to spell out the
 * whole state.
 */
export const DEFAULT_TAB_HINT = '[Ctrl+1-9] Switch  [Ctrl+T] New tab  [Ctrl+W] Close tab'

export function createTabBarState(
  panes: readonly WirePaneInfo[] = [],
  activePaneId?: string,
): TabBarState {
  return { panes, activePaneId, canCreate: true }
}

/**
 * Builds the view. The row list mirrors the pane list one-to-one so the
 * tab bar follows the host's ordering without a separate sort key.
 *
 * The `closable` flag is the same for every pane today — closing a tab is
 * never blocked at the host side — but it is a property of the row, not the
 * pane, so a future "pinned" affordance does not need a new field on the wire.
 */
export function tabBarView(state: TabBarState): TabBarView {
  const rows: TabRow[] = state.panes.map((pane) => ({
    paneId: pane.paneId,
    sessionId: pane.sessionId,
    title: pane.sessionTitle ?? 'Untitled',
    active: pane.paneId === state.activePaneId,
    closable: true,
  }))
  return {
    panes: state.panes,
    rows,
    activePaneId: state.activePaneId,
    hint: DEFAULT_TAB_HINT,
    hasNewTab: state.canCreate,
  }
}

/**
 * What a keystroke becomes in tab-bar terms. The shell routes the global
 * keymap here once it has decided the keystroke is for the tab bar.
 *
 * The chord shape mirrors the renderer keymap: `{ key, shiftKey, ctrlKey,
 * metaKey }`, with `ctrlKey`/`metaKey` already handled by the caller.
 */
export interface TabBarChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

export type TabBarIntent =
  | { kind: 'switch'; paneId: string }
  | { kind: 'close'; paneId: string }
  | { kind: 'new' }
  | { kind: 'none' }

/**
 * Maps a key chord onto a tab-bar intent.
 *
 * The chord is what the renderer keymap already produces; the test layer
 * exercises the same shape, so a model regression is caught here rather than
 * inside a DOM-level render.
 *
 * Numpad digit keys are not covered: the layout.ts hand-rolled width math has
 * no use for them, and a renderer that wants them can layer them on top.
 */
export function tabBarKeyToIntent(chord: TabBarChord, state: TabBarState): TabBarIntent {
  if (chord.ctrlKey === true || chord.metaKey === true) {
    // `Ctrl+1`–`Ctrl+9` switch to the nth pane; the terminal equivalent is
    // `Alt+1`–`Alt+9`, but the desktop shell piggybacks on the standard
    // browser tab shortcut.
    if (chord.key >= '1' && chord.key <= '9') {
      const index = Number.parseInt(chord.key, 10) - 1
      const target = state.panes[index]
      return target ? { kind: 'switch', paneId: target.paneId } : { kind: 'none' }
    }
    if (chord.key === 't' || chord.key === 'T') return { kind: 'new' }
    if (chord.key === 'w' || chord.key === 'W') {
      if (state.activePaneId === undefined) return { kind: 'none' }
      return { kind: 'close', paneId: state.activePaneId }
    }
  }

  return { kind: 'none' }
}

/**
 * Selects a pane by id; pure helper so `app.ts` and the test both have one
 * place to derive the active id from a click.
 */
export function findSwitch(state: TabBarState, paneId: string): TabBarIntent {
  if (!state.panes.some((pane) => pane.paneId === paneId)) return { kind: 'none' }
  return { kind: 'switch', paneId }
}

/**
 * Selects a close for a given pane id; same shape as `findSwitch` so the
 * click handler can be a single intent dispatch.
 */
export function findClose(state: TabBarState, paneId: string): TabBarIntent {
  if (!state.panes.some((pane) => pane.paneId === paneId)) return { kind: 'none' }
  return { kind: 'close', paneId }
}
