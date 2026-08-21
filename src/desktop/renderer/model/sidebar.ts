import type { WireLaneInfo, WireSessionSummary } from '../../shellProtocol.js'

/**
 * The sidebar as data: every session this process can reach, grouped by project
 * and sectioned by age, with the open ones marked.
 *
 * Replaces `model/tabBar.ts`, which only ever listed *open* panes. The ordering
 * discipline is inherited wholesale — a stable partition rather than a
 * comparator on a boolean, one flattened row list that both the view renders and
 * the digit chords index — and extended a level, from "project → tab" to
 * "project → age → session".
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

/**
 * Section labels, in one table.
 *
 * The view carries `kind` *and* `label` so tests assert the kind: 4e localizes
 * every string in the shell, and a suite pinned to literals would have to be
 * rewritten alongside it for no gain in coverage.
 */
export const SIDEBAR_SECTION_LABELS: Record<SidebarSectionKind, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '最近 7 天',
  older: '更早',
}

export const SIDEBAR_HINT =
  '[Ctrl+1-9] 切换  [Ctrl+T] 新会话  [Ctrl+W] 关闭  [Ctrl+B] 收起侧栏  [Ctrl+Shift+O] 打开项目'

// --- the view ----------------------------------------------------------------

export type SidebarSectionKind = 'today' | 'yesterday' | 'week' | 'older'

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

export interface SidebarSection {
  readonly kind: SidebarSectionKind
  readonly label: string
  readonly rows: readonly SidebarRow[]
}

export interface SidebarGroup {
  readonly projectRoot: string
  readonly projectName: string
  /** This is the project the active pane belongs to; its group sorts first. */
  readonly own: boolean
  readonly sections: readonly SidebarSection[]
  /** The group's rows flattened, in the order the sections render them. */
  readonly rows: readonly SidebarRow[]
}

export interface SidebarView {
  readonly groups: readonly SidebarGroup[]
  /**
   * Every row, flattened in **visual** order. Keyboard navigation walks this,
   * so the cursor and the screen cannot disagree.
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
  /** Headings are noise for a single project, so they appear from two up. */
  readonly showProjectLabels: boolean
  readonly selectedIndex: number
  /** Whether "new session" and "open project" are offered. */
  readonly canCreate: boolean
  /** Nothing to list at all — the empty state, not merely a collapsed sidebar. */
  readonly isEmpty: boolean
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
  readonly sessions: readonly WireSessionSummary[]
}

/** What a live pane contributes that no wire field carries. */
export interface SidebarLaneStatus {
  readonly streaming: boolean
  /** An unanswered blocking request is parked on this pane. */
  readonly blocked: boolean
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
  /** Milliseconds, injected so section boundaries are testable. */
  readonly now: number
  /** False while a blocking dialog is up: both buttons open something. */
  readonly canCreate: boolean
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
    now: Date.UTC(2026, 7, 20, 12, 0, 0),
    canCreate: true,
    ...overrides,
  }
}

// --- building the view -------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const SECTION_ORDER: readonly SidebarSectionKind[] = ['today', 'yesterday', 'week', 'older']

/**
 * Which section a session falls in, by local calendar day rather than by elapsed
 * hours: a session touched at 23:50 is "yesterday" at 00:10, not "today", which
 * is what a reader means by the word.
 *
 * An unparseable `updatedAt` lands in `older` rather than throwing — the store
 * self-heals rather than rejecting bad records, and a row the user can still
 * delete is more useful than a sidebar that will not draw.
 */
export function sectionFor(updatedAt: string, now: number): SidebarSectionKind {
  const touched = Date.parse(updatedAt)
  if (!Number.isFinite(touched)) return 'older'
  const startOfToday = startOfDay(now)
  if (touched >= startOfToday) return 'today'
  if (touched >= startOfToday - DAY_MS) return 'yesterday'
  if (touched >= startOfToday - 6 * DAY_MS) return 'week'
  return 'older'
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function badgeFor(lane: string | undefined, state: SidebarState): SidebarBadge {
  if (lane === undefined) return 'none'
  const status = state.laneStatus.get(lane)
  if (!status) return 'none'
  // Awaiting input outranks running: a turn parked on a permission prompt is
  // technically still streaming, and "waiting for you" is the actionable half.
  if (status.blocked) return 'awaiting-input'
  return status.streaming ? 'running' : 'none'
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

  // Keyed by project root and insertion-ordered, so projects appear in the order
  // `list-sessions` reported them and a project known only from a lane lands
  // after the ones with history.
  const byProject = new Map<string, { projectName: string; rows: SidebarRow[] }>()
  const bucketFor = (projectRoot: string, projectName: string) => {
    const existing = byProject.get(projectRoot)
    if (existing) return existing
    const created = { projectName, rows: [] as SidebarRow[] }
    byProject.set(projectRoot, created)
    return created
  }

  const seen = new Set<string>()
  for (const project of state.projects) {
    const bucket = bucketFor(project.projectRoot, project.projectName)
    for (const session of project.sessions) {
      seen.add(session.id)
      const lane = laneBySession.get(session.id)
      bucket.rows.push(rowFor(session, project.projectRoot, lane?.lane, active?.paneId, state))
    }
  }

  // Lanes with nothing behind them on disk: a fresh draft has no index entry
  // until its first message. Appended after a project's history because that is
  // where the newest thing belongs — and never dropped, since dropping one would
  // hide the session the user is typing into.
  //
  // Synthesized into the same summary shape rather than built by a second row
  // constructor: badge, active and confirming are one decision each, and two
  // constructors is two places for them to drift.
  for (const lane of state.lanes) {
    if (seen.has(lane.paneId)) continue
    seen.add(lane.paneId)
    const draft: WireSessionSummary = {
      id: lane.paneId,
      ...(lane.sessionTitle !== undefined ? { title: lane.sessionTitle } : {}),
      // Nothing written yet, so "now" is the truth — and it puts the draft under
      // 今天 where the user just made it.
      updatedAt: new Date(state.now).toISOString(),
      messageCount: 0,
    }
    bucketFor(lane.projectRoot, lane.projectName).rows.push(
      rowFor(draft, lane.projectRoot, lane.lane, active?.paneId, state),
    )
  }

  const groups = [...byProject.entries()].map(([projectRoot, bucket]) =>
    groupOf(projectRoot, bucket.projectName, active?.projectRoot, bucket.rows, state),
  )

  // A stable partition, not a sort: `filter` twice keeps first-seen order inside
  // each half, where a comparator on a boolean would leave it to the engine.
  // Inherited verbatim from the tab bar this replaced, and it only reorders on a
  // *cross-project* switch — within one project the list never moves.
  const ordered = [...groups.filter((group) => group.own), ...groups.filter((group) => !group.own)]
  const rows = ordered.flatMap((group) => group.rows)

  return {
    groups: ordered,
    rows,
    liveRows: rows.filter((row) => row.lane !== undefined),
    activeProjectRoot: active?.projectRoot,
    collapsed: state.collapsed,
    showProjectLabels: ordered.length > 1,
    selectedIndex: clampIndex(state.selectedIndex, rows.length),
    canCreate: state.canCreate,
    isEmpty: rows.length === 0,
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
 * Splits a project's rows into age sections, dropping empty ones.
 *
 * The row order *within* a section is the order it arrived, which for the store
 * is newest-first (`SessionStore.list` sorts on `updatedAt` descending). This
 * does not re-sort: two sources feed the list, and re-sorting would move a draft
 * that has no meaningful timestamp yet.
 */
function groupOf(
  projectRoot: string,
  projectName: string,
  activeProjectRoot: string | undefined,
  rows: readonly SidebarRow[],
  state: SidebarState,
): SidebarGroup {
  const buckets = new Map<SidebarSectionKind, SidebarRow[]>()
  for (const row of rows) {
    const kind = sectionFor(row.updatedAt, state.now)
    const bucket = buckets.get(kind)
    if (bucket) bucket.push(row)
    else buckets.set(kind, [row])
  }

  const sections: SidebarSection[] = []
  for (const kind of SECTION_ORDER) {
    const bucket = buckets.get(kind)
    if (!bucket || bucket.length === 0) continue
    sections.push({ kind, label: SIDEBAR_SECTION_LABELS[kind], rows: bucket })
  }

  return {
    projectRoot,
    projectName,
    // Unknown active project ⇒ nothing is own, so the wire order stands. Not
    // "everything is own" (the old tab bar's choice): there, own governed whether a
    // row could be closed; here it only governs group order, and hoisting every
    // group is the same as hoisting none.
    own: activeProjectRoot !== undefined && projectRoot === activeProjectRoot,
    sections,
    rows: sections.flatMap((section) => section.rows),
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
  | { kind: 'toggle-collapse' }
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
 * `updatedAt` is deliberately absent — it is not drawn, only bucketed, and the
 * bucket shows up as `section.kind`.
 */
export function sidebarRenderSignature(view: SidebarView): string {
  const parts: string[] = [
    view.collapsed ? 'c' : '-',
    view.canCreate ? 'n' : '-',
    view.isEmpty ? 'e' : '-',
    view.showProjectLabels ? 'l' : '-',
    String(view.selectedIndex),
  ]
  for (const group of view.groups) {
    parts.push(`g:${group.projectRoot}${group.projectName}${group.own ? '1' : '0'}`)
    for (const section of group.sections) {
      parts.push(`s:${section.kind}`)
      for (const row of section.rows) {
        parts.push(
          `r:${row.sessionId}${row.lane ?? ''}${row.badge}${row.active ? '1' : '0'}`
            + `${row.confirmingDelete ? '1' : '0'}${row.title}${row.messageCount}`,
        )
      }
    }
  }
  return parts.join('')
}

function activeProjectRootOf(state: SidebarState): string | undefined {
  if (state.activeLane === undefined) return undefined
  return state.lanes.find((lane) => lane.lane === state.activeLane)?.projectRoot
}
