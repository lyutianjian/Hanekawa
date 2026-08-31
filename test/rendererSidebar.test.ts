import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activateRow,
  createSidebarState,
  moveSelection,
  newSessionIntent,
  sidebarChordToIntent,
  sidebarKeyToIntent,
  sidebarRenderSignature,
  sidebarView,
  toggleProject,
  workspaceRootsOf,
  type SidebarProjectSessions,
  type SidebarState,
  type SidebarView,
} from '../src/desktop/renderer/model/sidebar.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'
import type { WireSessionSummary } from '../src/desktop/shellProtocol.js'

/**
 * The sidebar model — grouping by workspace, folding, badges, and the two key
 * entry points.
 *
 * Assertions land on `kind` rather than on labels: 4e localizes every string in
 * the shell, and a suite pinned to literals would have to be rewritten alongside
 * it without covering anything more.
 *
 * The load-bearing cases:
 *
 * - `sidebarChordToIntent` answers `'none'` without ctrl/meta. It resolves
 *   *before* the global keymap, so anything else silently shadows every dialog.
 * - `Ctrl+1`–`9` indexes the open rows only. Reaching into history would turn a
 *   switch into an open.
 * - A live lane with no file behind it still gets a row, or the session the user
 *   is typing into disappears from the list.
 * - A folded workspace contributes no rows to `rows`/`liveRows`, or the cursor
 *   and `Ctrl+1`–`9` step into sessions that are not on screen.
 */

const NOW = new Date(2026, 7, 20, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

function at(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString()
}

function session(id: string, overrides: Partial<WireSessionSummary> = {}): WireSessionSummary {
  return { id, updatedAt: at(0), messageCount: 3, ...overrides }
}

function project(
  projectRoot: string,
  projectName: string,
  sessions: WireSessionSummary[],
): SidebarProjectSessions {
  return { projectRoot, projectName, sessions }
}

function lane(key: string, paneId: string, projectRoot: string, overrides: Partial<WireLaneInfo> = {}): WireLaneInfo {
  return {
    lane: key,
    paneId,
    sessionId: paneId,
    projectRoot,
    projectName: projectRoot.split(/[\\/]/).pop() ?? projectRoot,
    ...overrides,
  }
}

function stateWith(overrides: Partial<SidebarState> = {}): SidebarState {
  return createSidebarState({ now: NOW, ...overrides })
}

// --- ordering inside a workspace ---------------------------------------------

test('a workspace lists its sessions newest first, with no age sections', () => {
  // The age sections are gone: workspace is the only grouping axis, and inside a
  // group the list is simply a timeline.
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [
          session('s-old', { updatedAt: at(40 * DAY) }),
          session('s-today', { updatedAt: at(0) }),
          session('s-week', { updatedAt: at(3 * DAY) }),
        ]),
      ],
    }),
  )

  assert.deepEqual(
    view.rows.map((row) => row.sessionId),
    ['s-today', 's-week', 's-old'],
  )
  assert.deepEqual(view.groups[0]!.rows, view.rows, 'the group carries the same order')
})

test('an unparseable timestamp sorts oldest rather than throwing', () => {
  // The store self-heals rather than rejecting bad records, so a row the user can
  // still delete beats a sidebar that will not draw.
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [
          session('broken', { updatedAt: 'not a date' }),
          session('fine', { updatedAt: at(40 * DAY) }),
        ]),
      ],
    }),
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['fine', 'broken'])
})

// --- grouping ---------------------------------------------------------------

test('the active pane project sorts first, and the rest keep wire order', () => {
  const state = stateWith({
    projects: [
      project('/a', 'alpha', [session('a1')]),
      project('/b', 'beta', [session('b1')]),
      project('/c', 'gamma', [session('c1')]),
    ],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })

  const view = sidebarView(state)
  assert.deepEqual(
    view.groups.map((group) => group.projectName),
    ['beta', 'alpha', 'gamma'],
  )
  assert.deepEqual(view.groups.map((group) => group.own), [true, false, false])
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['b1', 'a1', 'c1'])
})

test('with no active lane nothing is own and the wire order stands', () => {
  // Not "everything is own" — that was the old tab bar's choice, where own governed
  // closability. Here it only governs group order, and hoisting every group is
  // the same as hoisting none.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    }),
  )
  assert.deepEqual(view.groups.map((group) => group.own), [false, false])
  assert.deepEqual(view.groups.map((group) => group.projectName), ['alpha', 'beta'])
})

// --- folding ----------------------------------------------------------------

test('a folded workspace keeps its rows but contributes none to the cursor', () => {
  // The heading still says how many are inside (`group.rows`), but `rows` is the
  // index space for the cursor and `Ctrl+1`–`9`, and both have to mean what is on
  // screen.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'b1', '/b')],
    collapsedProjects: new Set(['/a']),
  })
  const view = sidebarView(state)

  assert.deepEqual(view.groups.map((group) => group.collapsed), [true, false])
  assert.equal(view.groups[0]!.rows.length, 2, 'the folded group still knows what it holds')
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['b1'])
  assert.deepEqual(view.liveRows.map((row) => row.lane), ['2'])
  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state), { kind: 'switch', lane: '2' })
  assert.deepEqual(
    sidebarChordToIntent({ key: '2', ctrlKey: true }, state),
    { kind: 'none' },
    'the folded workspace\u2019s lane is not reachable by chord',
  )
})

test('folding every workspace is not the empty state', () => {
  // "Nothing here" and "you folded it all up" are different screens, and the
  // second one still has headings to click.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')])],
      collapsedProjects: new Set(['/a']),
    }),
  )
  assert.deepEqual(view.rows, [])
  assert.equal(view.isEmpty, false)
  assert.equal(view.noMatches, false)
})

test('a search unfolds everything, or its matches would be hidden', () => {
  const view = sidebarView(
    stateWith({
      searchQuery: 'one',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])],
      collapsedProjects: new Set(['/a']),
    }),
  )
  assert.equal(view.groups[0]!.collapsed, false)
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1'])
})

test('toggleProject folds, unfolds, and takes a forced answer', () => {
  const shut = toggleProject(new Set(), '/a')
  assert.deepEqual([...shut], ['/a'])
  assert.deepEqual([...toggleProject(shut, '/a')], [], 'a second toggle opens it again')
  // The reveal path forces "open" rather than toggling: clicking the Hero project
  // name of an already-open workspace must not fold it.
  assert.deepEqual([...toggleProject(shut, '/a', false)], [])
  assert.deepEqual([...toggleProject(new Set(), '/a', false)], [])
})

test('the workspace roots are every project, with the active pane\u2019s first', () => {
  const roots = workspaceRootsOf(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
      lanes: [lane('2', 'b1', '/b'), lane('3', 'x', 'C:\\repo\\solo')],
      activeLane: '2',
    }),
  )
  assert.deepEqual(roots, ['/b', '/a', 'C:\\repo\\solo'])
})

// --- history × topology -----------------------------------------------------

test('a live lane with nothing on disk still gets a row', () => {
  // A fresh draft has no index entry until its first message. Dropping the row
  // would hide the session the user is typing into.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1', { title: 'Yesterday', updatedAt: at(30 * DAY) })])],
      lanes: [lane('1', 'draft-1', '/a')],
      activeLane: '1',
    }),
  )

  assert.deepEqual(view.rows.map((row) => row.sessionId), ['draft-1', 'a1'])
  assert.equal(view.rows[0]!.lane, '1')
  assert.equal(view.rows[0]!.active, true)
})

test('a session on disk carries its lane when one is open', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1'), session('a2')])],
      lanes: [lane('7', 'a2', '/a')],
    }),
  )

  assert.equal(view.rows.find((row) => row.sessionId === 'a1')!.lane, undefined)
  assert.equal(view.rows.find((row) => row.sessionId === 'a2')!.lane, '7')
  assert.deepEqual(view.liveRows.map((row) => row.sessionId), ['a2'])
})

test('a lane whose project has no history entry is grouped from its own fields', () => {
  const view = sidebarView(
    stateWith({ lanes: [lane('1', 'x', 'C:\\repo\\solo')] }),
  )
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]!.projectName, 'solo')
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['x'])
})

test('a session with no title still names itself', () => {
  const view = sidebarView(stateWith({ projects: [project('/a', 'alpha', [session('a1')])] }))
  assert.equal(typeof view.rows[0]!.title, 'string')
  assert.ok(view.rows[0]!.title.length > 0)
})

test('an empty directory reports the empty state', () => {
  const view = sidebarView(stateWith({}))
  assert.equal(view.isEmpty, true)
  assert.deepEqual(view.rows, [])
  assert.equal(view.selectedIndex, -1)
})

// --- badges -----------------------------------------------------------------

test('badges come off the pane snapshot, with awaiting-input outranking running', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3'), session('a4')])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'a2', '/a'), lane('3', 'a3', '/a')],
    laneStatus: new Map([
      ['1', { streaming: true, blocked: false }],
      // Still streaming, but parked on a prompt: "waiting for you" is the
      // actionable half, so it wins.
      ['2', { streaming: true, blocked: true }],
      ['3', { streaming: false, blocked: false }],
    ]),
  })

  const badges = new Map(sidebarView(state).rows.map((row) => [row.sessionId, row.badge]))
  assert.equal(badges.get('a1'), 'running')
  assert.equal(badges.get('a2'), 'awaiting-input')
  assert.equal(badges.get('a3'), 'none')
  assert.equal(badges.get('a4'), 'none', 'a closed session has no pane to report')
})

test('a lane with no status entry yet carries no badge', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')])],
      lanes: [lane('1', 'a1', '/a')],
    }),
  )
  assert.equal(view.rows[0]!.badge, 'none')
})

// --- search -----------------------------------------------------------------

test('the search box filters rows by title, case-insensitively and across projects', () => {
  const state = stateWith({
    searchQuery: 'REPORT',
    projects: [
      project('/a', 'alpha', [
        session('a1', { title: 'Weekly report' }),
        session('a2', { title: 'Bugfix' }),
      ]),
      project('/b', 'beta', [session('b1', { title: 'Report draft' })]),
    ],
  })
  const view = sidebarView(state)
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'b1'])
  // Beta kept a match, alpha's second session did not; both groups still stand.
  assert.deepEqual(view.groups.map((group) => group.projectName), ['alpha', 'beta'])
})

test('an empty query keeps every row', () => {
  const view = sidebarView(
    stateWith({
      searchQuery: '   ',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })])],
    }),
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'a2'])
  assert.equal(view.noMatches, false)
  assert.equal(view.isEmpty, false)
})

test('a search that matches nothing reports noMatches, not the empty state', () => {
  // The two are different screens: "no sessions yet" versus "nothing matched
  // your search", and the sidebar draws a different message for each.
  const view = sidebarView(
    stateWith({
      searchQuery: 'zzz',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])],
    }),
  )
  assert.deepEqual(view.rows, [])
  assert.equal(view.noMatches, true)
  assert.equal(view.isEmpty, false)

  // A genuinely empty directory is the empty state, never noMatches.
  const empty = sidebarView(stateWith({ searchQuery: '' }))
  assert.equal(empty.isEmpty, true)
  assert.equal(empty.noMatches, false)
})

// --- global chords ----------------------------------------------------------

test('an unmodified key is never a sidebar intent', () => {
  // The whole reason these chords may resolve before the global keymap. An
  // unmodified key answering here would shadow every dialog in the window.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
  })
  for (const key of ['1', '2', 'b', 'B', 't', 'w', 'o', 'Enter', 'Escape', 'ArrowDown', 'x']) {
    assert.deepEqual(
      sidebarChordToIntent({ key }, state),
      { kind: 'none' },
      `expected ${key} without a modifier to be none`,
    )
  }
})

test('Ctrl+1-9 switches among open lanes in visual order', () => {
  const state = stateWith({
    projects: [
      project('/a', 'alpha', [session('a1'), session('a2')]),
      project('/b', 'beta', [session('b1')]),
    ],
    lanes: [lane('5', 'a2', '/a'), lane('6', 'b1', '/b')],
    activeLane: '6',
  })

  // Visual order hoists beta (the active pane's project), so its lane is first.
  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state), { kind: 'switch', lane: '6' })
  assert.deepEqual(sidebarChordToIntent({ key: '2', ctrlKey: true }, state), { kind: 'switch', lane: '5' })
  assert.deepEqual(sidebarChordToIntent({ key: '3', ctrlKey: true }, state), { kind: 'none' })
})

test('Ctrl+1-9 never reaches into history', () => {
  // Three sessions on disk, one open. The chord means "switch between live
  // panes"; letting it index closed rows would turn a switch into an open.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3')])],
    lanes: [lane('9', 'a3', '/a')],
  })

  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state), { kind: 'switch', lane: '9' })
  assert.deepEqual(sidebarChordToIntent({ key: '2', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(sidebarChordToIntent({ key: '3', ctrlKey: true }, state), { kind: 'none' })
})

test('Ctrl+B toggles the sidebar, on either modifier', () => {
  const state = stateWith({})
  assert.deepEqual(sidebarChordToIntent({ key: 'b', ctrlKey: true }, state), { kind: 'toggle-collapse' })
  assert.deepEqual(sidebarChordToIntent({ key: 'B', metaKey: true }, state), { kind: 'toggle-collapse' })
})

test('Ctrl+Shift+O resolves before the unshifted letters', () => {
  // A browser reports `'O'` for Ctrl+Shift+O, so the letter branches below would
  // never see it — but checking the modifier is what keeps this honest on a
  // layout that disagrees.
  const state = stateWith({})
  assert.deepEqual(
    sidebarChordToIntent({ key: 'O', ctrlKey: true, shiftKey: true }, state),
    { kind: 'open-project' },
  )
  assert.deepEqual(
    sidebarChordToIntent({ key: 'o', ctrlKey: true, shiftKey: true }, state),
    { kind: 'open-project' },
  )
})

test('Ctrl+T targets the active pane project, and answers without one', () => {
  const withActive = stateWith({
    projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 't', ctrlKey: true }, withActive), {
    kind: 'new',
    projectRoot: '/b',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 'T', ctrlKey: true }, stateWith({})), { kind: 'new' })
})

test('Ctrl+W closes the active lane, and does nothing without one', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('4', 'a1', '/a')],
    activeLane: '4',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', ctrlKey: true }, state), { kind: 'close', lane: '4' })
  assert.deepEqual(
    sidebarChordToIntent({ key: 'w', ctrlKey: true }, stateWith({})),
    { kind: 'none' },
  )
})

// --- sidebar-focused keys ---------------------------------------------------

const NAV_STATE = stateWith({
  projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3')])],
  lanes: [lane('1', 'a2', '/a')],
})

test('a modified key is not a sidebar-focused intent', () => {
  // The two entry points must not both claim a chord: the global one already
  // answered it before focus was consulted.
  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowDown', ctrlKey: true }, NAV_STATE), { kind: 'none' })
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter', metaKey: true }, NAV_STATE), { kind: 'none' })
})

test('arrows move the cursor and clamp at both ends', () => {
  const at = (selectedIndex: number): SidebarView => sidebarView({ ...NAV_STATE, selectedIndex })
  assert.equal(moveSelection(at(-1), 'down'), 0, 'no cursor yet: down enters at the top')
  assert.equal(moveSelection(at(-1), 'up'), 2, 'and up enters at the bottom')
  assert.equal(moveSelection(at(1), 'down'), 2)
  assert.equal(moveSelection(at(2), 'down'), 2, 'clamps rather than wrapping')
  assert.equal(moveSelection(at(0), 'up'), 0)
  assert.equal(moveSelection(sidebarView(stateWith({})), 'down'), -1, 'nothing to select')

  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowUp' }, NAV_STATE), { kind: 'move', direction: 'up' })
  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowDown' }, NAV_STATE), { kind: 'move', direction: 'down' })
})

test('an out-of-range cursor is clamped rather than trusted', () => {
  const view = sidebarView({ ...NAV_STATE, selectedIndex: 99 })
  assert.equal(view.selectedIndex, 2)
})

test('Enter opens a closed row and switches to an open one, exactly like a click', () => {
  const onClosed = sidebarKeyToIntent({ key: 'Enter' }, { ...NAV_STATE, selectedIndex: 0 })
  assert.deepEqual(onClosed, { kind: 'open', projectRoot: '/a', sessionId: 'a1' })

  const onOpen = sidebarKeyToIntent({ key: 'Enter' }, { ...NAV_STATE, selectedIndex: 1 })
  assert.deepEqual(onOpen, { kind: 'switch', lane: '1' })

  // The click path is the same decision, so the two cannot drift apart.
  const rows = sidebarView(NAV_STATE).rows
  assert.deepEqual(activateRow(rows[0]!), onClosed)
  assert.deepEqual(activateRow(rows[1]!), onOpen)
})

test('Enter with no cursor does nothing', () => {
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, NAV_STATE), { kind: 'none' })
})

// --- deletion ---------------------------------------------------------------

test('Delete asks, Enter confirms, Escape cancels', () => {
  const asking = sidebarKeyToIntent({ key: 'Delete' }, { ...NAV_STATE, selectedIndex: 0 })
  assert.deepEqual(asking, { kind: 'request-delete', sessionId: 'a1' })

  const pending: SidebarState = { ...NAV_STATE, selectedIndex: 0, pendingDelete: 'a1' }
  assert.equal(sidebarView(pending).rows[0]!.confirmingDelete, true)
  assert.equal(sidebarView(pending).rows[1]!.confirmingDelete, false, 'only the asked row')

  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, pending), {
    kind: 'confirm-delete',
    projectRoot: '/a',
    sessionId: 'a1',
  })
  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, pending), { kind: 'cancel-delete' })
})

test('Backspace asks too, and a second ask on a pending row is ignored', () => {
  assert.deepEqual(sidebarKeyToIntent({ key: 'Backspace' }, { ...NAV_STATE, selectedIndex: 2 }), {
    kind: 'request-delete',
    sessionId: 'a3',
  })
  assert.deepEqual(
    sidebarKeyToIntent({ key: 'Delete' }, { ...NAV_STATE, selectedIndex: 0, pendingDelete: 'a1' }),
    { kind: 'none' },
  )
})

test('Escape with nothing pending falls through to the global keymap', () => {
  // Otherwise Escape in the sidebar would stop meaning "interrupt the turn".
  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, NAV_STATE), { kind: 'none' })
})

test('an open session can be confirmed for deletion — the lane closes first', () => {
  // The host closes the lane before touching the store; the model just has to
  // offer the action on a row that has one.
  const pending: SidebarState = { ...NAV_STATE, selectedIndex: 1, pendingDelete: 'a2' }
  assert.equal(sidebarView(pending).rows[1]!.lane, '1')
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, pending), {
    kind: 'confirm-delete',
    projectRoot: '/a',
    sessionId: 'a2',
  })
})

// --- chrome -----------------------------------------------------------------

test('canCreate gates the buttons *and* the chords, and collapsing keeps the data', () => {
  const state = stateWith({
    canCreate: false,
    collapsed: true,
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
  })
  const blocked = sidebarView(state)
  assert.equal(blocked.canCreate, false)
  assert.equal(blocked.collapsed, true)
  assert.equal(blocked.rows.length, 1, 'a collapsed sidebar still knows what it holds')

  // "Key path and button must agree": a chord that fires while the button is
  // disabled makes the disabled state a lie.
  assert.deepEqual(sidebarChordToIntent({ key: 't', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(
    sidebarChordToIntent({ key: 'O', ctrlKey: true, shiftKey: true }, state),
    { kind: 'none' },
  )
  // Switching, closing and collapsing are not "create", so they still work.
  assert.deepEqual(sidebarChordToIntent({ key: 'b', ctrlKey: true }, state), { kind: 'toggle-collapse' })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', ctrlKey: true }, state), { kind: 'close', lane: '1' })
})

test('the new-session intent is one decision, so the button and Ctrl+T agree', () => {
  // They did not: the button emitted a bare `{kind:'new'}`, and `ShellHost`
  // falls back to the *first project opened* when no root rides along — so with
  // two projects open the button created the session in the wrong one.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })
  const view = sidebarView(state)
  assert.equal(view.activeProjectRoot, '/b')
  assert.deepEqual(
    sidebarChordToIntent({ key: 't', ctrlKey: true }, state),
    newSessionIntent(view.activeProjectRoot),
  )
  assert.deepEqual(newSessionIntent(undefined), { kind: 'new' }, 'no active pane: let the host choose')
})

// --- the render signature ---------------------------------------------------

test('the signature moves for everything the view draws', () => {
  // The guard behind it skips the repaint when the signature matches, so a field
  // that is drawn but not signed goes stale on screen. Each case below changes
  // one drawn thing and must therefore change the signature.
  const base = stateWith({
    projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
    selectedIndex: 0,
  })
  const of = (state: SidebarState): string => sidebarRenderSignature(sidebarView(state))
  const reference = of(base)

  assert.equal(of(stateWith({ ...base })), reference, 'an identical state signs identically')

  const moved: Array<[string, SidebarState]> = [
    ['collapsed', { ...base, collapsed: true }],
    ['canCreate', { ...base, canCreate: false }],
    ['selectedIndex', { ...base, selectedIndex: 1 }],
    ['pendingDelete', { ...base, pendingDelete: 'a1' }],
    // 'o' matches both 'One' and 'Two', so the row set is unchanged — this
    // isolates the query field itself moving the signature.
    ['searchQuery', { ...base, searchQuery: 'o' }],
    ['a folded workspace', { ...base, collapsedProjects: new Set(['/a']) }],
    ['badge', { ...base, laneStatus: new Map([['1', { streaming: true, blocked: false }]]) }],
    ['title', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'Renamed' }), session('a2', { title: 'Two' })])] }],
    ['messageCount', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One', messageCount: 99 }), session('a2', { title: 'Two' })])] }],
    ['a row gained a lane', { ...base, lanes: [lane('1', 'a1', '/a'), lane('2', 'a2', '/a')] }],
    ['active row', { ...base, lanes: [lane('1', 'a2', '/a')] }],
    ['row set', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])] }],
    // The order the rows sort into is what the timeline shows up as, now that
    // there are no section headings to sign.
    ['row order', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One', updatedAt: at(40 * DAY) }), session('a2', { title: 'Two' })])] }],
    ['a second project', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })]), project('/b', 'beta', [session('b1')])] }],
  ]
  for (const [what, state] of moved) {
    assert.notEqual(of(state), reference, `expected ${what} to move the signature`)
  }
})

test('the signature ignores what the view does not draw', () => {
  // `updatedAt` is sorted on, never rendered — so a change that does not move a
  // row must not force a rebuild of every row.
  const rows = (updatedAt: string): SidebarState =>
    stateWith({ projects: [project('/a', 'alpha', [session('a1', { title: 'One', updatedAt })])] })
  assert.equal(
    sidebarRenderSignature(sidebarView(rows(at(0)))),
    sidebarRenderSignature(sidebarView(rows(at(60 * 1000)))),
    'a minute later, same order, same paint',
  )
})
