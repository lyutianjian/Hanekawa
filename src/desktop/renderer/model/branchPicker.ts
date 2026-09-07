/**
 * The welcome screen's branch switcher, as data.
 *
 * The empty state's branch pill names the branch this project is on; clicking it
 * opens this — one row per local branch, the current one ticked, and choosing a
 * row runs `git switch` host-side. It replaces the workspace picker that used to
 * hang off the Hero's project name: switching projects is what the sidebar is
 * for, and the pill was the one piece of the empty state describing something
 * the user might actually want to change from here.
 *
 * There is no search box. The list is short, and dropping it drops the hardest
 * constraint the old picker carried — a persistent `<input>` that had to survive
 * a repaint per streamed token to keep its caret.
 *
 * Three states share the popover and are mutually exclusive by construction:
 * `loading` while the host is listing, `error` when the switch was refused, and
 * the rows otherwise.
 *
 * DOM-free like every `model/` module: it is compiled in the base tsconfig
 * program, which has no DOM lib.
 */

export const BRANCH_PICKER_LOADING = '正在读取分支…'
export const BRANCH_PICKER_EMPTY = '没有其他分支'
export const BRANCH_PICKER_LABEL = '切换分支'

export interface BranchPickerState {
  readonly open: boolean
  /** Local branches as the host listed them, most recently committed first. */
  readonly branches: readonly string[]
  /** Where HEAD is, which is also what the pill draws. */
  readonly current: string | undefined
  /** The list is in flight. Re-set on every open — branches move outside the app. */
  readonly loading: boolean
  /**
   * git's refusal, kept on the popover rather than only posted as a notice: the
   * user is looking at the list they just clicked, and an error that appears
   * behind the popover is an error nobody reads.
   */
  readonly error: string | undefined
  /** The keyboard cursor into {@link BranchPickerView.rows}; `-1` for none. */
  readonly selectedIndex: number
  /**
   * A switch is in flight. Rows stop responding while it is: `git switch` moves
   * the working tree, and a second one queued behind the first would run against
   * a tree the user never saw.
   */
  readonly switching: boolean
}

export interface BranchPickerRow {
  readonly name: string
  /** The branch HEAD is on: ticked, and choosing it only closes the popover. */
  readonly current: boolean
  readonly selected: boolean
}

export interface BranchPickerView {
  readonly open: boolean
  readonly rows: readonly BranchPickerRow[]
  readonly loading: boolean
  readonly switching: boolean
  readonly error: string | undefined
  /** The list answered and held nothing — not the same state as `loading`. */
  readonly empty: boolean
}

export type BranchPickerIntent =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'pick'; branch: string }
  | { kind: 'move'; direction: 'up' | 'down' }
  | { kind: 'none' }

export function createBranchPickerState(
  overrides: Partial<BranchPickerState> = {},
): BranchPickerState {
  return {
    open: false,
    branches: [],
    current: undefined,
    loading: false,
    error: undefined,
    selectedIndex: -1,
    switching: false,
    ...overrides,
  }
}

export function branchPickerView(state: BranchPickerState): BranchPickerView {
  const selectedIndex = clampIndex(state.selectedIndex, state.branches.length)
  const rows = state.branches.map((name, index) => ({
    name,
    current: name === state.current,
    selected: index === selectedIndex,
  }))
  return {
    open: state.open,
    rows,
    loading: state.loading,
    switching: state.switching,
    error: state.error,
    empty: !state.loading && rows.length === 0,
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1
  return Math.min(index, length - 1)
}

/**
 * Where the cursor lands after an arrow. Clamps rather than wrapping — the same
 * `moveSelection` discipline the sidebar follows, and for the same reason: this
 * list is short, and a wrap from the last row to the first reads as a lost cursor.
 */
export function moveBranchSelection(
  view: BranchPickerView,
  direction: 'up' | 'down',
): number {
  if (view.rows.length === 0) return -1
  const current = view.rows.findIndex((row) => row.selected)
  if (current === -1) return direction === 'down' ? 0 : view.rows.length - 1
  const next = current + (direction === 'down' ? 1 : -1)
  return Math.max(0, Math.min(next, view.rows.length - 1))
}

export interface BranchPickerChord {
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
export function branchPickerKeyToIntent(
  chord: BranchPickerChord,
  view: BranchPickerView,
): BranchPickerIntent {
  if (!view.open) return { kind: 'none' }
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }
  if (chord.key === 'Escape') return { kind: 'close' }
  if (view.switching) return { kind: 'none' }
  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }
  if (chord.key === 'Enter') {
    const row = view.rows.find((one) => one.selected)
    // Enter with no cursor is not "take the first row": a stray Enter must not
    // move the working tree.
    if (!row) return { kind: 'none' }
    return row.current ? { kind: 'close' } : { kind: 'pick', branch: row.name }
  }
  return { kind: 'none' }
}

/**
 * Everything the popover's DOM depends on, in one string.
 *
 * Load-bearing for the same reason `welcomeRenderSignature` is: this is drawn
 * from the pane's single transcript paint, which runs once per streamed token.
 */
export function branchPickerSignature(view: BranchPickerView): string {
  return [
    view.open ? '1' : '0',
    view.loading ? 'l' : '-',
    view.switching ? 's' : '-',
    view.empty ? 'e' : '-',
    view.error ?? '',
    ...view.rows.map((row) => `${row.current ? '1' : '0'}${row.selected ? '1' : '0'}${row.name}`),
  ].join(' ')
}
