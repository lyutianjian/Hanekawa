import type { WireLaneInfo, WireSessionSummary } from '../../shellProtocol.js'

/**
 * The sidebar as data: every session this process can reach, grouped by
 * workspace, with the open ones marked.
 *
 * Replaces `model/tabBar.ts`, which only ever listed *open* panes. The ordering
 * discipline is inherited wholesale — a stable partition rather than a
 * comparator on a boolean, one flattened row list that both the view renders and
 * the digit chords index — and extended a level, from "project → tab" to
 * "workspace → session".
 *
 * Workspace is the *only* grouping axis. It used to be two ("project → age →
 * session") behind a header dropdown that switched which project you were
 * looking at, which made the workspace something you navigated *to* before you
 * could see its sessions. Every workspace is now on screen at once, its group
 * collapsible, and the age sections are gone — inside a group the rows are
 * simply newest first.
 *
 * Two things this file is careful about:
 *
 * 1. **Badges are derived, not transported.** `running` and `awaiting-input`
 *    come from the pane's own `SessionClient` snapshot and its unanswered
 *    blocking requests, both of which the renderer already has. No wire field
 *    was added for them, so nothing can go stale between the host and the row.
 * 2. **There are two key entry points, and they are not interchangeable.**
 *    `sidebarChordToIntent` runs *before* the global keymap and therefore must
 *    answer `'none'` for anything without ctrl/meta — an unmodified key that
 *    resolved here would silently shadow every dialog in the window.
 *    `sidebarKeyToIntent` runs only while focus is inside the sidebar, which is
 *    what lets arrows and Enter mean navigation without stealing them from the
 *    composer.
 *
 * DOM-free on purpose; see `keymap.ts` for why (`model/` is compiled in the base
 * tsconfig program, which has no DOM lib).
 */

// --- text --------------------------------------------------------------------

export const SIDEBAR_HINT =
  '[Ctrl+1-9] 切换  [Ctrl+T] 新会话  [Ctrl+W] 关闭  [Ctrl+B] 收起侧栏  [Ctrl+Shift+O] 打开项目'

// --- the view ----------------------------------------------------------------

/** What a row says about the pane behind it, if there is one. */
export type SidebarBadge = 'none' | 'running' | 'awaiting-input'

export interface SidebarRow {
  readonly sessionId: string
  readonly title: string
  readonly projectRoot: string
  /** The lane this session is open on, absent when it is only history. */
  readonly lane?: string
  readonly badge: SidebarBadge
  /** The row the window is currently showing. At most one row is active. */
  readonly active: boolean
  readonly updatedAt: string
  readonly messageCount: number
  /** This row is asking "delete?" and has replaced its actions with the answer. */
  readonly confirmingDelete: boolean
}

/** One workspace's sessions, under its own heading. */
export interface SidebarGroup {
  readonly projectRoot: string
  readonly projectName: string
  /**
   * The home directory's implicit workspace rather than an added project.
   *
   * Read off the wire (`WireShellProjectSessions.isGlobal`), never matched on
   * the display name. The one group that cannot be removed from the sidebar,
   * because there is no registry entry to forget.
   */
  readonly isGlobal: boolean
  /** This group's context menu is open, so the view draws it under the heading. */
  readonly menuOpen: boolean
  /** This group is asking "remove?" and has replaced its `+` with the answer. */
  readonly confirmingRemove: boolean
  /**
   * Folded shut, so the view draws the heading and none of the rows.
   *
   * A collapsed group's rows are still carried here (the heading shows how
   * many), but they are absent from {@link SidebarView.rows} — the cursor and
   * `Ctrl+1`–`9` walk what is on screen, and a keyboard that steps into a hidden
   * row is a cursor the user cannot see.
   */
  readonly collapsed: boolean
  /** The group's sessions, newest first. Populated even while collapsed. */
  readonly rows: readonly SidebarRow[]
}

export interface SidebarView {
  readonly groups: readonly SidebarGroup[]
  /**
   * Every *visible* row, flattened in **visual** order — collapsed groups
   * contribute nothing. Keyboard navigation walks this, so the cursor and the
   * screen cannot disagree.
   */
  readonly rows: readonly SidebarRow[]
  /**
   * The open rows only, in the same visual order. `Ctrl+1`–`9` indexes *this*
   * rather than `rows`: the chord has always meant "switch between live panes",
   * and letting it reach into history would turn a switch into an open.
   */
  readonly liveRows: readonly SidebarRow[]
  /** The active pane's project, which is also the group hoisted to the top. */
  readonly activeProjectRoot: string | undefined
  readonly collapsed: boolean
  readonly selectedIndex: number
  /** Whether "new session" and "open project" are offered. */
  readonly canCreate: boolean
  /** Nothing to list at all — the empty state, not merely a collapsed sidebar. */
  readonly isEmpty: boolean
  /** The current search text, so the box can reflect it and the miss state read. */
  readonly searchQuery: string
  /** A search is active but matched nothing — distinct from an empty project. */
  readonly noMatches: boolean
  /**
   * Whether the `?` panel is showing {@link SIDEBAR_HINT}.
   *
   * The chord list used to be printed under the footer at all times, which put a
   * two-line wall of 10px text where the reference builds have a user row and a
   * `?` (design_guidance 三.2). The text is the same; the difference is that it
   * is now asked for.
   */
  readonly helpOpen: boolean
}

/**
 * One project's history, as `list-sessions` reports it.
 *
 * The session shape is the wire's narrow projection, not `SessionMeta`: the
 * sidebar reads four fields, and two of the ones it does not read
 * (`checkpoints`, `denialState`) grow without bound.
 */
export interface SidebarProjectSessions {
  readonly projectRoot: string
  readonly projectName: string
  /** See {@link SidebarGroup.isGlobal}. Absent is treated as "an added project". */
  readonly isGlobal?: boolean
  readonly sessions: readonly WireSessionSummary[]
}

/** What a live pane contributes that no wire field carries. */
export interface SidebarLaneStatus {
  readonly streaming: boolean
  /** An unanswered blocking request is parked on this pane. */
  readonly blocked: boolean
  /** A background process (shell or agent task) is still running on this pane. */
  readonly processes: boolean
  /**
   * Whether the pane's transcript has any conversation in it — the visibility
   * rule for a session that exists only as a lane: a new session stays
   * invisible until its first input or output.
   */
  readonly hasConversation: boolean
}

export interface SidebarState {
  /** History, per project, in the order projects were opened. */
  readonly projects: readonly SidebarProjectSessions[]
  /** The lane topology, which is a subset of the history plus fresh drafts. */
  readonly lanes: readonly WireLaneInfo[]
  /** Keyed by lane. A lane with no entry contributes no badge. */
  readonly laneStatus: ReadonlyMap<string, SidebarLaneStatus>
  readonly activeLane: string | undefined
  readonly collapsed: boolean
  /** The keyboard cursor into {@link SidebarView.rows}; `-1` for "no cursor". */
  readonly selectedIndex: number
  /** The session whose row is asking for confirmation, if any. */
  readonly pendingDelete: string | undefined
  /** The project whose heading has a context menu open, if any. */
  readonly projectMenu: string | undefined
  /** The project whose heading is asking "remove from the sidebar?", if any. */
  readonly pendingRemoveProject: string | undefined
  /** Milliseconds, injected so a draft's synthesized timestamp is testable. */
  readonly now: number
  /** False while a blocking dialog is up: both buttons open something. */
  readonly canCreate: boolean
  /** The session-search text; empty means no filter. */
  readonly searchQuery: string
  /**
   * The workspaces folded shut, by project root.
   *
   * Renderer-local and deliberately not persisted: it is a view fold, not a
   * preference, and a project that came back collapsed after a restart would
   * look like its sessions were gone.
   */
  readonly collapsedProjects: ReadonlySet<string>
  /** Whether the footer's `?` panel is open. */
  readonly helpOpen: boolean
}

export function createSidebarState(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    projects: [],
    lanes: [],
    laneStatus: new Map(),
    activeLane: undefined,
    collapsed: false,
    selectedIndex: -1,
    pendingDelete: undefined,
    projectMenu: undefined,
    pendingRemoveProject: undefined,
    now: Date.UTC(2026, 7, 20, 12, 0, 0),
    canCreate: true,
    searchQuery: '',
    collapsedProjects: new Set(),
    helpOpen: false,
    ...overrides,
  }
}

// --- building the view -------------------------------------------------------

/**
 * A row's place on the timeline, as a number.
 *
 * An unparseable `updatedAt` sorts oldest rather than throwing — the store
 * self-heals rather than rejecting bad records, and a row the user can still
 * delete is more useful than a sidebar that will not draw.
 */
function touchedAt(updatedAt: string): number {
  const touched = Date.parse(updatedAt)
  return Number.isFinite(touched) ? touched : 0
}

function badgeFor(lane: string | undefined, state: SidebarState): SidebarBadge {
  if (lane === undefined) return 'none'
  const status = state.laneStatus.get(lane)
  if (!status) return 'none'
  // Awaiting input outranks running: a turn parked on a permission prompt is
  // technically still streaming, and "waiting for you" is the actionable half.
  if (status.blocked) return 'awaiting-input'
  // "Running" is the agent loop *or* a process it left behind — a backgrounded
  // command keeps the session busy after the turn ends.
  return status.streaming || status.processes ? 'running' : 'none'
}

/**
 * Builds the sidebar.
 *
 * The row set is the union of two sources, and the union is the point: history
 * comes from the store, but a fresh draft has no file yet and exists only as a
 * lane. Listing only one of them would either hide the session the user is
 * typing into or hide everything they did yesterday.
 */
export function sidebarView(state: SidebarState): SidebarView {
  const active = state.activeLane === undefined
    ? undefined
    : state.lanes.find((lane) => lane.lane === state.activeLane)
  const laneBySession = new Map<string, WireLaneInfo>()
  for (const lane of state.lanes) laneBySession.set(lane.paneId, lane)

  // Case-insensitive title substring. Empty query keeps every row — the filter
  // reads on the built row's `title`, which is where the "未命名会话" fallback
  // already lives, so a search matches what the user actually sees.
  const needle = state.searchQuery.trim().toLowerCase()
  const matches = (row: SidebarRow): boolean =>
    needle === '' || row.title.toLowerCase().includes(needle)

  // Keyed by project root and insertion-ordered, so projects appear in the
  // order `list-sessions` reported them and a project known only from a lane lands
  // after the ones with history.
  const byProject = new Map<
    string,
    { projectName: string; isGlobal: boolean; rows: SidebarRow[] }
  >()
  const bucketFor = (projectRoot: string, projectName: string, isGlobal = false) => {
    const existing = byProject.get(projectRoot)
    if (existing) return existing
    const created = { projectName, isGlobal, rows: [] as SidebarRow[] }
    byProject.set(projectRoot, created)
    return created
  }

  /** Whether a lane's session has had any input or output — see the lane pass. */
  const laneHasConversation = (lane: string): boolean =>
    state.laneStatus.get(lane)?.hasConversation ?? false

  // Sessions the history pull listed *and drew*. A listed-but-hidden (still
  // empty) session must not count as seen — the lane pass below is what brings
  // it on screen the moment its pane has content, without waiting for the next
  // pull.
  const seen = new Set<string>()
  for (const project of state.projects) {
    const bucket = bucketFor(project.projectRoot, project.projectName, project.isGlobal ?? false)
    for (const session of project.sessions) {
      // A session with no input and no output stays invisible — that is the
      // whole rule for new sessions, and history with nothing in it (a
      // not-yet-cleaned empty session) gets the same answer.
      if (session.messageCount === 0) continue
      seen.add(session.id)
      const lane = laneBySession.get(session.id)
      const row = rowFor(session, project.projectRoot, lane?.lane, active?.paneId, state)
      if (matches(row)) bucket.rows.push(row)
    }
  }

  // Lanes the history pull cannot speak for: a fresh draft has no index entry
  // until its first message, and a mid-first-turn session is listed with
  // `messageCount: 0` until the next pull. Either way the pane's own transcript
  // is the live truth — the row exists exactly when there is a conversation in
  // it, so a new session is invisible until its first input or output and
  // cannot blink out between submit and the turn's end.
  //
  // Synthesized into the same summary shape rather than built by a second row
  // constructor: badge, active and confirming are one decision each, and two
  // constructors is two places for them to drift.
  for (const lane of state.lanes) {
    if (seen.has(lane.paneId)) continue
    if (!laneHasConversation(lane.lane)) continue
    const draft: WireSessionSummary = {
      id: lane.paneId,
      ...(lane.sessionTitle !== undefined ? { title: lane.sessionTitle } : {}),
      // Nothing written yet, so "now" is the truth — and it puts the draft at the
      // top of its group, where the user just made it.
      updatedAt: new Date(state.now).toISOString(),
      messageCount: 0,
    }
    const row = rowFor(draft, lane.projectRoot, lane.lane, active?.paneId, state)
    const bucket = bucketFor(lane.projectRoot, lane.projectName)
    if (matches(row)) bucket.rows.push(row)
  }

  // Drop only what the *search* emptied. Without a query an empty bucket keeps
  // its group: a project is a place, not a label on a pile of sessions, so one
  // whose sessions were all deleted still draws its heading — and stays
  // clickable — until the user removes it from the sidebar on purpose. The host
  // decides which projects are listed at all (`listSessions`); this filter used
  // to quietly overrule it.
  const searching = needle !== ''
  const groups = [...byProject.entries()]
    .filter(([, bucket]) => !searching || bucket.rows.length > 0)
    .map(([projectRoot, bucket]) =>
      groupOf(projectRoot, bucket.projectName, bucket.rows, {
        // A search un-folds everything: the whole point of the query is to find a
        // session, and a match hidden behind a collapsed heading reads as "no
        // such session".
        collapsed: !searching && state.collapsedProjects.has(projectRoot),
        isGlobal: bucket.isGlobal,
        // A menu or a confirmation on a group that is being searched away would
        // be unanswerable, so both read on the same filtered set the view draws.
        menuOpen: state.projectMenu === projectRoot,
        confirmingRemove: state.pendingRemoveProject === projectRoot,
      }),
    )

  // The wire order stands: registry order (the order projects were added, first
  // added first, global workspace last). Activation is deliberately
  // imperceptible — no hoisting, no highlight — so switching sessions never
  // moves anything on screen; the canvas header, not the sidebar, says where you
  // are. The registry itself is stable across opens, so creating a session in a
  // project cannot move its group either.
  const ordered = groups
  // Collapsed groups are drawn as a heading and nothing else, so they are absent
  // here: this list is the cursor's and the digit chords' index space, and both
  // have to mean what is on screen.
  const rows = ordered.filter((group) => !group.collapsed).flatMap((group) => group.rows)

  // `groups` is empty only when there is genuinely nothing; a collapsed group is
  // still something to show, so the empty state reads on the groups rather than
  // on the visible rows.
  const nothing = ordered.length === 0
  return {
    groups: ordered,
    rows,
    liveRows: rows.filter((row) => row.lane !== undefined),
    activeProjectRoot: active?.projectRoot,
    collapsed: state.collapsed,
    selectedIndex: clampIndex(state.selectedIndex, rows.length),
    canCreate: state.canCreate,
    isEmpty: nothing && !searching,
    searchQuery: state.searchQuery,
    noMatches: nothing && searching,
    helpOpen: state.helpOpen,
  }
}

function rowFor(
  session: WireSessionSummary,
  projectRoot: string,
  lane: string | undefined,
  activePaneId: string | undefined,
  state: SidebarState,
): SidebarRow {
  return {
    sessionId: session.id,
    title: session.title ?? '未命名会话',
    projectRoot,
    ...(lane !== undefined ? { lane } : {}),
    badge: badgeFor(lane, state),
    active: session.id === activePaneId,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    confirmingDelete: state.pendingDelete === session.id,
  }
}

/**
 * One workspace's group: its rows, newest first.
 *
 * Sorted here rather than trusted, because two sources feed the list —
 * `SessionStore.list` already answers newest-first, but the drafts appended
 * after it are the *newest* things in the group and arrive last. A stable sort
 * keeps same-instant rows in arrival order, so a draft made in the same
 * millisecond as a save does not shuffle between paints.
 */
function groupOf(
  projectRoot: string,
  projectName: string,
  rows: readonly SidebarRow[],
  options: { collapsed: boolean; isGlobal: boolean; menuOpen: boolean; confirmingRemove: boolean },
): SidebarGroup {
  return {
    projectRoot,
    projectName,
    isGlobal: options.isGlobal,
    menuOpen: options.menuOpen,
    confirmingRemove: options.confirmingRemove,
    collapsed: options.collapsed,
    rows: [...rows].sort((left, right) => touchedAt(right.updatedAt) - touchedAt(left.updatedAt)),
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1
  return Math.min(index, length - 1)
}

// --- intents -----------------------------------------------------------------

export type SidebarIntent =
  /** Make an already-open lane the visible one. Renderer-local; no host round trip. */
  | { kind: 'switch'; lane: string }
  /** Open a session from history as a new lane. */
  | { kind: 'open'; projectRoot: string; sessionId: string }
  /** Release a lane's runtime. The session stays on disk. */
  | { kind: 'close'; lane: string }
  | { kind: 'new'; projectRoot?: string }
  | { kind: 'open-project' }
  /** Swap the canvas for the settings screen. Window-level, not per session. */
  | { kind: 'open-settings' }
  | { kind: 'toggle-collapse' }
  /** Set the session-search filter. */
  | { kind: 'search'; query: string }
  /** Fold one workspace's group shut, or open it again. */
  | { kind: 'toggle-project'; projectRoot: string }
  /** Open a heading's context menu, or close whatever is open (`undefined`). */
  | { kind: 'open-project-menu'; projectRoot: string | undefined }
  /** Ask the heading "remove from the sidebar?" — the menu item's answer. */
  | { kind: 'request-remove-project'; projectRoot: string }
  /** Unregister the project. Its sessions stay on disk; only the row goes. */
  | { kind: 'confirm-remove-project'; projectRoot: string }
  | { kind: 'cancel-remove-project' }
  /** Open or close the footer's `?` panel. */
  | { kind: 'toggle-help' }
  | { kind: 'request-delete'; sessionId: string }
  | { kind: 'confirm-delete'; projectRoot: string; sessionId: string }
  | { kind: 'cancel-delete' }
  | { kind: 'move'; direction: 'up' | 'down' }
  | { kind: 'none' }

export interface SidebarChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * The **global** chords, resolved before `resolveKey`.
 *
 * Everything here requires ctrl or meta, and the early return is what makes the
 * ordering safe: an unmodified key that resolved to an intent would shadow every
 * dialog, panel and composer keystroke in the window. The tab bar this replaced had the
 * same rule and the same reason.
 */
export function sidebarChordToIntent(chord: SidebarChord, state: SidebarState): SidebarIntent {
  if (chord.ctrlKey !== true && chord.metaKey !== true) return { kind: 'none' }

  // `Ctrl+1`–`9` over the *live* rows in visual order, so the nth chord and the
  // nth open session on screen are the same pane. The view is built inside this
  // branch rather than above the switch: it groups and sections every row, and
  // every other chord here discards it.
  if (chord.key >= '1' && chord.key <= '9') {
    const target = sidebarView(state).liveRows[Number.parseInt(chord.key, 10) - 1]
    if (target?.lane === undefined) return { kind: 'none' }
    return { kind: 'switch', lane: target.lane }
  }

  // Shift-qualified first: a browser reports `'O'` for Ctrl+Shift+O, so the
  // unshifted branches below would never see it — but testing the modifier
  // rather than the case is what keeps this honest on a layout that disagrees.
  if (chord.shiftKey === true && (chord.key === 'o' || chord.key === 'O')) {
    // Gated on `canCreate` like the button is: "key path and button must agree"
    // is a shell rule, and a chord that fires while a blocking prompt is up is
    // the button's disabled state being a lie.
    return state.canCreate ? { kind: 'open-project' } : { kind: 'none' }
  }
  if (chord.key === 'b' || chord.key === 'B') return { kind: 'toggle-collapse' }
  if (chord.key === 't' || chord.key === 'T') {
    if (!state.canCreate) return { kind: 'none' }
    return newSessionIntent(activeProjectRootOf(state))
  }
  if (chord.key === 'w' || chord.key === 'W') {
    if (state.activeLane === undefined) return { kind: 'none' }
    return { kind: 'close', lane: state.activeLane }
  }

  return { kind: 'none' }
}

/**
 * The keys that only apply while focus is inside the sidebar.
 *
 * Kept out of the global handler on purpose: arrows and Enter belong to the
 * composer and to whatever dropdown is open, and claiming them globally to move
 * a list cursor would be a regression the moment anyone typed. Escape here
 * cancels a pending delete rather than interrupting the turn, which is only
 * correct *because* it is scoped to the sidebar having focus.
 */
export function sidebarKeyToIntent(chord: SidebarChord, state: SidebarState): SidebarIntent {
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }

  if (chord.key === 'Escape') {
    // Innermost first, the `settingsKeyToIntent` ordering: a menu, then the
    // question it opened, then the row's own confirmation. Escape backs out one
    // layer at a time rather than clearing everything at once.
    if (state.projectMenu !== undefined) return { kind: 'open-project-menu', projectRoot: undefined }
    if (state.pendingRemoveProject !== undefined) return { kind: 'cancel-remove-project' }
    return state.pendingDelete !== undefined ? { kind: 'cancel-delete' } : { kind: 'none' }
  }
  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }

  const view = sidebarView(state)
  const row = view.rows[view.selectedIndex]
  if (!row) return { kind: 'none' }

  if (chord.key === 'Enter') {
    // A row already asking for confirmation answers *yes* — the confirm is the
    // thing under the cursor, not the session behind it.
    if (row.confirmingDelete) {
      return { kind: 'confirm-delete', projectRoot: row.projectRoot, sessionId: row.sessionId }
    }
    // Through `activateRow` so Enter and a click cannot drift apart about what
    // "open or switch" means.
    return activateRow(row)
  }
  if (chord.key === 'Delete' || chord.key === 'Backspace') {
    if (row.confirmingDelete) return { kind: 'none' }
    return { kind: 'request-delete', sessionId: row.sessionId }
  }

  return { kind: 'none' }
}

/**
 * Where the cursor lands after a move. Clamps rather than wrapping: the list is
 * long and grouped, and wrapping from the last project's oldest session to the
 * first project's newest is a jump nobody asked for.
 *
 * Takes the built view rather than the state, because every caller already has
 * one — an arrow key used to build three.
 */
export function moveSelection(view: SidebarView, direction: 'up' | 'down'): number {
  if (view.rows.length === 0) return -1
  if (view.selectedIndex === -1) return direction === 'down' ? 0 : view.rows.length - 1
  const next = view.selectedIndex + (direction === 'down' ? 1 : -1)
  return Math.max(0, Math.min(next, view.rows.length - 1))
}

/**
 * What a click on a row means. The one place "open or switch" is decided, so the
 * mouse path and the Enter path cannot drift apart.
 */
export function activateRow(row: SidebarRow): SidebarIntent {
  if (row.lane !== undefined) return { kind: 'switch', lane: row.lane }
  return { kind: 'open', projectRoot: row.projectRoot, sessionId: row.sessionId }
}

/**
 * "New session", targeted at a project. The one place that decision is made, for
 * the reason `activateRow` exists: `Ctrl+T` resolved the project and the button
 * did not, so with two projects open the button created the session in whichever
 * was opened *first* — `ShellHost` falls back to `directory.entries()[0]` when
 * the intent carries no root, and its tooltip promised the current project.
 */
export function newSessionIntent(projectRoot: string | undefined): SidebarIntent {
  return { kind: 'new', ...(projectRoot !== undefined ? { projectRoot } : {}) }
}

/**
 * The workspaces with a group on screen, in visual order.
 *
 * Built from `state` rather than from a built view so callers that only need the
 * roots — "which project does this pane belong to", the reveal path — do not pay
 * for grouping. History projects come first in wire order (added order, first
 * added first); a project known only from a lane lands after them. No hoisting:
 * activation is imperceptible, so the order never moves.
 */
export function workspaceRootsOf(state: SidebarState): readonly string[] {
  const roots: string[] = []
  const add = (root: string): void => {
    if (!roots.includes(root)) roots.push(root)
  }
  for (const project of state.projects) add(project.projectRoot)
  for (const lane of state.lanes) add(lane.projectRoot)
  return roots
}

/**
 * Folding a workspace open or shut, as the next collapsed set.
 *
 * A `Set` rather than a toggle on the state so `app.ts` holds one field and this
 * file owns what "toggle" means — including that revealing a project is the same
 * operation with the answer fixed.
 */
export function toggleProject(
  collapsed: ReadonlySet<string>,
  projectRoot: string,
  force?: boolean,
): ReadonlySet<string> {
  const next = new Set(collapsed)
  const shut = force ?? !next.has(projectRoot)
  if (shut) next.add(projectRoot)
  else next.delete(projectRoot)
  return next
}

/**
 * Everything the DOM draws, as one comparable string.
 *
 * The sidebar repaints from `onShellChanged`, which fires on every
 * `SessionClient` snapshot change — and that includes background-task
 * `outputBytes`, so a backgrounded `npm test` would rebuild every history row at
 * output-flush rate. Rebuilding is not cheap: ~9 nodes and 2 listeners per row,
 * unbounded by the conversation because rows are *sessions on disk*.
 *
 * So the view compares this first and returns early when nothing it draws has
 * moved — the same field-diff discipline `SessionClient.applySnapshot` and
 * `ShellClient.applyLanes` use, and for the same reason. It must cover every
 * field `render()` reads: a field drawn but not signed goes stale on screen.
 * `updatedAt` is deliberately absent — it is not drawn, only sorted on, and the
 * order it produces shows up as the order the rows are signed in.
 */
export function sidebarRenderSignature(view: SidebarView): string {
  const parts: string[] = [
    view.collapsed ? 'c' : '-',
    view.canCreate ? 'n' : '-',
    view.isEmpty ? 'e' : '-',
    view.noMatches ? 'm' : '-',
    // Signed, or the panel opens and the render guard swallows the repaint —
    // the failure this signature exists to prevent.
    view.helpOpen ? 'h' : '-',
    String(view.selectedIndex),
    `q:${view.searchQuery}`,
  ]
  for (const group of view.groups) {
    // The menu and the confirmation are drawn on the heading, a collapsed
    // group's included, so they are signed even where the rows below are not —
    // an unsigned `menuOpen` is a right-click the render guard swallows.
    parts.push(
      `g:${group.projectRoot}${group.projectName}${group.collapsed ? '1' : '0'}${group.isGlobal ? 'g' : '-'}`
        + `${group.menuOpen ? 'm' : '-'}${group.confirmingRemove ? 'r' : '-'}${group.rows.length}`,
    )
    if (group.collapsed) continue
    for (const row of group.rows) {
      parts.push(
        `r:${row.sessionId}${row.lane ?? ''}${row.badge}${row.active ? '1' : '0'}`
          + `${row.confirmingDelete ? '1' : '0'}${row.title}${row.messageCount}`,
      )
    }
  }
  return parts.join('')
}

function activeProjectRootOf(state: SidebarState): string | undefined {
  if (state.activeLane === undefined) return undefined
  return state.lanes.find((lane) => lane.lane === state.activeLane)?.projectRoot
}
