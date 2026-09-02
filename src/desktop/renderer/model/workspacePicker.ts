/**
 * The welcome screen's workspace picker, as data.
 *
 * The Hero names this pane's project; clicking that name opens this — a search
 * box, one row per known project with the current one ticked, and two actions:
 * add a project, or work outside one. It replaces `revealWorkspace()`, which
 * expanded the rail and focused a heading: correct, and invisible enough that
 * the Hero's project name read as a button that did nothing.
 *
 * Picking a *different* project opens a new session there rather than moving
 * this one. That is not a shortcut — a runtime is built per project and a live
 * session cannot change its own cwd — so the row means the same thing the
 * sidebar heading's `+` does, and goes through the same `newSessionIntent`.
 *
 * DOM-free like every `model/` module: it is compiled in the base tsconfig
 * program, which has no DOM lib.
 */

/** Where the rows come from: `list-sessions`, projected to what a row draws. */
export interface WorkspaceOption {
  readonly projectRoot: string
  readonly projectName: string
  /** The home-rooted workspace. Never a row — it is the「不在项目中工作」action. */
  readonly isGlobal: boolean
}

export const WORKSPACE_PICKER_SEARCH_PLACEHOLDER = '搜索项目'
export const WORKSPACE_PICKER_NEW_PROJECT = '新建项目'
export const WORKSPACE_PICKER_NO_PROJECT = '不在项目中工作'
export const WORKSPACE_PICKER_NO_MATCHES = '没有匹配的项目'

export interface WorkspacePickerState {
  readonly open: boolean
  readonly query: string
  /** Every workspace the shell listed, global one included; filtered here. */
  readonly options: readonly WorkspaceOption[]
  /** This pane's own project root, so its row can be ticked. */
  readonly currentRoot: string | undefined
  /**
   * The home workspace's root key, from `list-sessions`. Absent until the first
   * pull answers, which is why「不在项目中工作」can be missing for a frame.
   */
  readonly globalRoot: string | undefined
  /** The keyboard cursor into {@link WorkspacePickerView.rows}; `-1` for none. */
  readonly selectedIndex: number
}

export interface WorkspacePickerRow {
  readonly projectRoot: string
  readonly projectName: string
  /** The workspace this pane is already in: ticked, and a click only closes. */
  readonly current: boolean
  readonly selected: boolean
}

export interface WorkspacePickerView {
  readonly open: boolean
  readonly query: string
  readonly rows: readonly WorkspacePickerRow[]
  /** A query is active and matched nothing, which is not "no projects yet". */
  readonly noMatches: boolean
  /**
   * Whether「不在项目中工作」is offered. False in the global workspace itself
   * (there is nowhere to go) and before the root key is known.
   */
  readonly canLeaveProject: boolean
}

export type WorkspacePickerIntent =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'search'; query: string }
  /** Open a new session in this project — see the header for why not a switch. */
  | { kind: 'pick'; projectRoot: string }
  /**
   * The row for the workspace this pane is *already* in. Nothing is opened; the
   * sidebar puts that project's group on screen, which is the only useful answer
   * to "yes, this one" — and the behaviour the Hero's name used to have alone.
   */
  | { kind: 'reveal'; projectRoot: string }
  /** The directory picker, the sidebar's `open-project` by another door. */
  | { kind: 'new-project' }
  /** A session in the global workspace, which belongs to no project. */
  | { kind: 'no-project' }
  | { kind: 'move'; direction: 'up' | 'down' }
  | { kind: 'none' }

export function createWorkspacePickerState(
  overrides: Partial<WorkspacePickerState> = {},
): WorkspacePickerState {
  return {
    open: false,
    query: '',
    options: [],
    currentRoot: undefined,
    globalRoot: undefined,
    selectedIndex: -1,
    ...overrides,
  }
}

export function workspacePickerView(state: WorkspacePickerState): WorkspacePickerView {
  // Case-insensitive substring on the display name, the same rule
  // `sidebarView`'s `matches` uses — the user searches what they can read.
  const needle = state.query.trim().toLowerCase()
  const matched = state.options
    .filter((option) => !option.isGlobal)
    .filter((option) => needle === '' || option.projectName.toLowerCase().includes(needle))

  const selectedIndex = clampIndex(state.selectedIndex, matched.length)
  const rows = matched.map((option, index) => ({
    projectRoot: option.projectRoot,
    projectName: option.projectName,
    current: option.projectRoot === state.currentRoot,
    selected: index === selectedIndex,
  }))

  return {
    open: state.open,
    query: state.query,
    rows,
    noMatches: rows.length === 0 && needle !== '',
    canLeaveProject:
      state.globalRoot !== undefined && state.globalRoot !== state.currentRoot,
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1
  return Math.min(index, length - 1)
}

/**
 * Where the cursor lands after an arrow. Clamps rather than wrapping, the
 * `moveSelection` discipline: this list is short and a wrap from the last
 * project to the first reads as the cursor being lost.
 */
export function moveWorkspaceSelection(
  view: WorkspacePickerView,
  direction: 'up' | 'down',
): number {
  if (view.rows.length === 0) return -1
  const current = view.rows.findIndex((row) => row.selected)
  if (current === -1) return direction === 'down' ? 0 : view.rows.length - 1
  const next = current + (direction === 'down' ? 1 : -1)
  return Math.max(0, Math.min(next, view.rows.length - 1))
}

export interface WorkspacePickerChord {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * The keys that apply only while the picker is open and focus is inside it.
 *
 * Scoped, not global: Escape here must not interrupt a turn and Enter must not
 * submit the composer, which is only safe because the caller routes on focus —
 * the same split `sidebarKeyToIntent` lives on.
 */
export function workspacePickerKeyToIntent(
  chord: WorkspacePickerChord,
  view: WorkspacePickerView,
): WorkspacePickerIntent {
  if (!view.open) return { kind: 'none' }
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }
  if (chord.key === 'Escape') return { kind: 'close' }
  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }
  if (chord.key === 'Enter') {
    const row = view.rows.find((one) => one.selected)
    // Enter with no cursor is not "pick the first thing": the search box has
    // focus by default, and a stray Enter there would open a session.
    if (!row) return { kind: 'none' }
    return row.current
      ? { kind: 'reveal', projectRoot: row.projectRoot }
      : { kind: 'pick', projectRoot: row.projectRoot }
  }
  return { kind: 'none' }
}

/**
 * Everything the picker's DOM depends on, in one string.
 *
 * Load-bearing for the same reason `welcomeRenderSignature` is: this is drawn
 * from the pane's single transcript paint, which runs once per streamed token.
 * The query is signed but the *input's value* is never written back from it —
 * the node is persistent, so a keystroke must not rebuild the box it came from.
 */
export function workspacePickerSignature(view: WorkspacePickerView): string {
  return [
    view.open ? '1' : '0',
    view.noMatches ? 'm' : '-',
    view.canLeaveProject ? 'g' : '-',
    ...view.rows.map(
      (row) => `${row.projectRoot}${row.current ? '1' : '0'}${row.selected ? '1' : '0'}${row.projectName}`,
    ),
  ].join(' ')
}
