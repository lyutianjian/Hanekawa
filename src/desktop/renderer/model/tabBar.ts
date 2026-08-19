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
 * With several projects open the bar also groups: every window lists *every*
 * pane in the process, under a heading per project. What a row allows depends on
 * whose project it is — see `closable` below.
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
  readonly projectRoot: string
  readonly projectName: string
  /** True when this row belongs to the window's own project. */
  readonly own: boolean
}

/** One project's tabs, in the order the host reported them. */
export interface TabGroup {
  readonly projectRoot: string
  readonly projectName: string
  readonly own: boolean
  readonly rows: readonly TabRow[]
}

export interface TabBarView {
  readonly panes: readonly WirePaneInfo[]
  /**
   * Every row, flattened in **visual** order (own project first). `Ctrl+1`–`9`
   * index this, so the nth chord and the nth tab on screen are the same tab.
   */
  readonly rows: readonly TabRow[]
  readonly groups: readonly TabGroup[]
  readonly activePaneId: string | undefined
  /** Hint shown in the status bar; mirrors the keymap. */
  readonly hint: string
  readonly hasNewTab: boolean
  readonly hasOpenProject: boolean
  /** Headings are noise for a single project, so they only appear from two up. */
  readonly showProjectLabels: boolean
}

export interface TabBarState {
  /** The full set of open panes, in display order. */
  readonly panes: readonly WirePaneInfo[]
  /** The pane that owns the focused window. May be absent on startup. */
  readonly activePaneId: string | undefined
  /** Whether the "+" button should be drawn. False while an overlay is open. */
  readonly canCreate: boolean
  /**
   * The project this window's own pane belongs to (`WireHelloResult.cwd`, already
   * normalized by the host).
   *
   * Absent until `hello()` resolves, in which case every row is treated as own —
   * at that point the only pane there is *is* this window's.
   */
  readonly ownProjectRoot?: string
}

/**
 * Static cols, kept as a default for tests that don't want to spell out the
 * whole state.
 */
export const DEFAULT_TAB_HINT =
  '[Ctrl+1-9] Switch  [Ctrl+T] New tab  [Ctrl+W] Close tab  [Ctrl+Shift+O] Open project'

export function createTabBarState(
  panes: readonly WirePaneInfo[] = [],
  activePaneId?: string,
  ownProjectRoot?: string,
): TabBarState {
  return {
    panes,
    activePaneId,
    canCreate: true,
    ...(ownProjectRoot !== undefined ? { ownProjectRoot } : {}),
  }
}

/**
 * Groups the panes by project, this window's own project first.
 *
 * Own-first rather than the wire order because the wire order is "the order the
 * projects were opened", which puts a window's own tabs in the middle of the bar
 * for the second project opened. Within a project the wire order stands.
 *
 * The single source of ordering: {@link tabBarView} renders it and
 * {@link tabBarKeyToIntent} indexes it, so the digit chords cannot disagree with
 * what is on screen.
 */
function groupRows(state: TabBarState): TabGroup[] {
  const groups = new Map<string, { projectName: string; own: boolean; rows: TabRow[] }>()

  for (const pane of state.panes) {
    // Unknown own project ⇒ treat everything as own: the pre-`hello` bar has
    // only this window's pane in it, and a row nobody can close would be worse.
    const own = state.ownProjectRoot === undefined || pane.projectRoot === state.ownProjectRoot
    const row: TabRow = {
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      title: pane.sessionTitle ?? 'Untitled',
      active: pane.paneId === state.activePaneId,
      // Another project's pane belongs to another `SessionWorkspace`, which this
      // window's host cannot close. Focus is the only verb we offer for it.
      closable: own,
      projectRoot: pane.projectRoot,
      projectName: pane.projectName,
      own,
    }
    const group = groups.get(pane.projectRoot)
    if (group) {
      group.rows.push(row)
      continue
    }
    groups.set(pane.projectRoot, { projectName: pane.projectName, own, rows: [row] })
  }

  const ordered = [...groups.entries()].map(([projectRoot, group]) => ({
    projectRoot,
    projectName: group.projectName,
    own: group.own,
    rows: group.rows as readonly TabRow[],
  }))
  // A stable partition, not a sort: `filter` twice keeps first-seen order inside
  // each half, where a comparator on a boolean would leave it to the engine.
  return [...ordered.filter((group) => group.own), ...ordered.filter((group) => !group.own)]
}

/**
 * Builds the view. The row list mirrors the pane list one-to-one so the
 * tab bar follows the host's ordering within each project.
 *
 * `closable` is per row rather than per pane — a foreign project's tab is
 * focus-only today, and a future "pinned" affordance needs no new wire field.
 */
export function tabBarView(state: TabBarState): TabBarView {
  const groups = groupRows(state)
  const rows = groups.flatMap((group) => group.rows)
  return {
    panes: state.panes,
    rows,
    groups,
    activePaneId: state.activePaneId,
    hint: DEFAULT_TAB_HINT,
    hasNewTab: state.canCreate,
    // Same gate as "+": both open something, and both are wrong while a blocking
    // dialog is up.
    hasOpenProject: state.canCreate,
    showProjectLabels: groups.length > 1,
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
  | { kind: 'open-project' }
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
    // browser tab shortcut. Indexed over the *visual* order, so this agrees
    // with the grouped bar rather than with the wire list.
    if (chord.key >= '1' && chord.key <= '9') {
      const index = Number.parseInt(chord.key, 10) - 1
      const target = tabBarView(state).rows[index]
      return target ? { kind: 'switch', paneId: target.paneId } : { kind: 'none' }
    }
    // Shift-qualified first: a browser sends `'O'` for Ctrl+Shift+O, so the
    // unshifted branches below would never see it — but checking the modifier
    // rather than the case is what keeps this honest on a layout that disagrees.
    if (chord.shiftKey === true && (chord.key === 'o' || chord.key === 'O')) {
      return { kind: 'open-project' }
    }
    if (chord.key === 't' || chord.key === 'T') return { kind: 'new' }
    if (chord.key === 'w' || chord.key === 'W') {
      if (state.activePaneId === undefined) return { kind: 'none' }
      return findClose(state, state.activePaneId)
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
 *
 * Refuses a pane this window cannot close — another project's pane lives in
 * another `SessionWorkspace`, and asking our host to close it would either fail
 * or (worse, before this existed) take down the wrong window. The DOM draws no
 * close button for those rows; this is the gate that makes that a rule rather
 * than a rendering detail.
 */
export function findClose(state: TabBarState, paneId: string): TabBarIntent {
  const row = tabBarView(state).rows.find((candidate) => candidate.paneId === paneId)
  if (!row || !row.closable) return { kind: 'none' }
  return { kind: 'close', paneId }
}
