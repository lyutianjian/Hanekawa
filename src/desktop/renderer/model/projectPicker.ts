/**
 * The welcome screen's project switcher, as data.
 *
 * The empty state's project pill names the project this pane runs in; clicking
 * it opens this — one row per *added* project, the current one ticked, and
 * choosing a row opens a fresh session there. It is the branch pill's shape
 * applied to the fact beside it: the two things the Hero states are where you
 * are and what you are on, and both are now things you can change from here.
 *
 * Smaller than `model/branchPicker.ts` on purpose. Branches come from git, so
 * that picker carries `loading`, `error` and `switching`; the project list is
 * the renderer's own — `app.ts` already holds it for the sidebar — so it is
 * handed over synchronously and there is nothing to wait for. Opening a session
 * *is* asynchronous, but it is a window-level act that the shell reports as a
 * transcript note, not a state this popover survives to draw: picking a row
 * closes it.
 *
 * The list is only the added projects. The global workspace (最近) is reachable
 * from the sidebar and is not a project you switch a Hero into, and there is no
 * 「打开项目…」row — adding a project is `Ctrl+Shift+O` and the title bar.
 *
 * DOM-free like every `model/` module: it is compiled in the base tsconfig
 * program, which has no DOM lib.
 */

export const PROJECT_PICKER_LABEL = '切换项目'
export const PROJECT_PICKER_EMPTY = '没有其他项目'

/** One added project, as the sidebar's history pull already describes it. */
export interface ProjectPickerEntry {
  /** The normalized project root — the key every host command is addressed by. */
  readonly root: string
  readonly name: string
}

export interface ProjectPickerState {
  readonly open: boolean
  /** The added projects, in registry order (the order the sidebar lists them). */
  readonly projects: readonly ProjectPickerEntry[]
  /** This pane's own project root, which is also what the pill draws. */
  readonly current: string | undefined
  /** The keyboard cursor into {@link ProjectPickerView.rows}; `-1` for none. */
  readonly selectedIndex: number
}

export interface ProjectPickerRow {
  readonly root: string
  readonly name: string
  /** The project this pane is in: ticked, and choosing it only closes the popover. */
  readonly current: boolean
  readonly selected: boolean
}

export interface ProjectPickerView {
  readonly open: boolean
  readonly rows: readonly ProjectPickerRow[]
  /** Nothing to list. Only reachable if a project was removed while this was open. */
  readonly empty: boolean
}

export type ProjectPickerIntent =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'pick'; root: string }
  | { kind: 'move'; direction: 'up' | 'down' }
  | { kind: 'none' }

export function createProjectPickerState(
  overrides: Partial<ProjectPickerState> = {},
): ProjectPickerState {
  return {
    open: false,
    projects: [],
    current: undefined,
    selectedIndex: -1,
    ...overrides,
  }
}

export function projectPickerView(state: ProjectPickerState): ProjectPickerView {
  const selectedIndex = clampIndex(state.selectedIndex, state.projects.length)
  const rows = state.projects.map((project, index) => ({
    root: project.root,
    name: project.name,
    current: project.root === state.current,
    selected: index === selectedIndex,
  }))
  return { open: state.open, rows, empty: rows.length === 0 }
}

/**
 * Whether the pill is worth making a control at all.
 *
 * A popover whose only row is the project you are already in switches nowhere,
 * and `model/welcome.ts` draws a non-interactive pill as a plain `<span>` — the
 * screen's rule that a button which does nothing is worse than text.
 */
export function canSwitchProject(state: ProjectPickerState): boolean {
  return state.projects.some((project) => project.root !== state.current)
}

function clampIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1
  return Math.min(index, length - 1)
}

/** Clamps rather than wrapping, the `moveBranchSelection` discipline. */
export function moveProjectSelection(
  view: ProjectPickerView,
  direction: 'up' | 'down',
): number {
  if (view.rows.length === 0) return -1
  const current = view.rows.findIndex((row) => row.selected)
  if (current === -1) return direction === 'down' ? 0 : view.rows.length - 1
  const next = current + (direction === 'down' ? 1 : -1)
  return Math.max(0, Math.min(next, view.rows.length - 1))
}

export interface ProjectPickerChord {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * The keys that apply only while the popover is open and focus is inside it.
 *
 * Scoped, not global: Escape here must not interrupt a turn and Enter must not
 * submit the composer, which is only safe because the caller routes on focus.
 */
export function projectPickerKeyToIntent(
  chord: ProjectPickerChord,
  view: ProjectPickerView,
): ProjectPickerIntent {
  if (!view.open) return { kind: 'none' }
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }
  if (chord.key === 'Escape') return { kind: 'close' }
  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }
  if (chord.key === 'Enter') {
    const row = view.rows.find((one) => one.selected)
    // Enter with no cursor is not "take the first row": a stray Enter must not
    // move the window into another project.
    if (!row) return { kind: 'none' }
    return row.current ? { kind: 'close' } : { kind: 'pick', root: row.root }
  }
  return { kind: 'none' }
}

/**
 * Everything the popover's DOM depends on, in one string.
 *
 * Load-bearing for the same reason `branchPickerSignature` is: this is drawn
 * from the pane's single transcript paint, which runs once per streamed token,
 * so a field drawn but not signed is a click the guard swallows.
 */
export function projectPickerSignature(view: ProjectPickerView): string {
  return [
    view.open ? '1' : '0',
    view.empty ? 'e' : '-',
    ...view.rows.map((row) => `${row.current ? '1' : '0'}${row.selected ? '1' : '0'}${row.root}${row.name}`),
  ].join(' ')
}
