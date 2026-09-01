import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createSidebarView } from '../src/desktop/renderer/dom/sidebarView.js'
import {
  SIDEBAR_HINT,
  sidebarView,
  createSidebarState,
  type SidebarIntent,
  type SidebarState,
  type SidebarView,
} from '../src/desktop/renderer/model/sidebar.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'

/**
 * The sidebar's four regions, as DOM.
 *
 * `test/rendererSidebar.test.ts` covers the model — which rows exist, what a key
 * means. What only shows up here is the shape: the workspace header is gone and
 * every workspace has a folding heading *in the list*, the first-level actions
 * are rows under the search box, and the chord list lives behind the footer's `?`
 * instead of being printed under it.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: SidebarIntent[]
  render(view: SidebarView): void
  focusProject(projectRoot: string): void
  root(): StubView
}

function viewOf(overrides: Partial<SidebarState> = {}): SidebarView {
  return sidebarView(createSidebarState(overrides))
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('sidebar')
  const intents: SidebarIntent[] = []
  const dom = createSidebarView(container, (intent) => intents.push(intent), () => false)
  return {
    stub,
    container,
    intents,
    render: (view) => dom.render(view),
    focusProject: (projectRoot) => dom.focusProject(projectRoot),
    root: () => stub.inspect(container),
  }
}

const region = (root: StubView, className: string): StubView => {
  const found = root.children.find((node) => node.classes.includes(className))
  assert.ok(found, `no .${className} in ${root.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every node in the rendered subtree, root included. */
const descendants = (node: StubView): StubView[] =>
  [node, ...node.children.flatMap(descendants)]

const find = (root: StubView, className: string): StubView | undefined =>
  descendants(root).find((node) => node.classes.includes(className))

const sessionRows = (root: StubView): StubView[] =>
  descendants(root).filter((node) => node.classes.includes('session-row'))

/** One project with three sessions: the visible one, a background lane, history. */
function tieredState(): Partial<SidebarState> {
  const root = '/w/app'
  const laneOf = (key: string, paneId: string): WireLaneInfo => ({
    lane: key,
    paneId,
    sessionId: paneId,
    projectRoot: root,
    projectName: 'app',
  })
  return {
    projects: [
      {
        projectRoot: root,
        projectName: 'app',
        sessions: [
          { id: 'shown', title: '正在显示', updatedAt: new Date(Date.UTC(2026, 7, 20, 11)).toISOString(), messageCount: 4 },
          { id: 'background', title: '后台 lane', updatedAt: new Date(Date.UTC(2026, 7, 20, 10)).toISOString(), messageCount: 2 },
          { id: 'history', title: '只是历史', updatedAt: new Date(Date.UTC(2026, 7, 20, 9)).toISOString(), messageCount: 7 },
        ],
      },
    ],
    lanes: [laneOf('l1', 'shown'), laneOf('l2', 'background')],
    activeLane: 'l1',
  }
}

test('the sidebar opens on the search box: there is no workspace header', (t) => {
  // The dropdown that used to live here made a workspace something you navigated
  // *to* before you could see its sessions. Every workspace is a heading in the
  // list now, so the control that chose between them has nothing left to do.
  const { render, root } = mount(t)
  render(viewOf())

  assert.equal(root().children[0]?.className, 'sidebar-search')
  assert.equal(find(root(), 'sidebar-header'), undefined, 'the workspace header came back')
  assert.equal(find(root(), 'sidebar-workspace'), undefined, 'the workspace dropdown came back')
  assert.equal(find(root(), 'sidebar-collapse'), undefined, 'the sidebar grew a second collapse control')
})

test('collapsing hides every region', (t) => {
  // The rail survived only so this view's own toggle stayed clickable. With that
  // toggle in the title bar, a collapsed sidebar is zero width — and a region
  // still drawn would be what keeps the column from reaching it.
  const { render, root } = mount(t)
  render(viewOf({ collapsed: true }))

  for (const name of ['sidebar-search', 'sidebar-nav', 'sidebar-list', 'sidebar-footer']) {
    assert.equal(region(root(), name).hidden, true, `.${name} is still on screen while collapsed`)
  }
})

test('every workspace gets a folding heading, single project included', (t) => {
  // Drawn even for one project: the workspace is the list's only grouping axis,
  // so hiding the heading when there is one of them hides *what the axis is*.
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const heading = find(root(), 'project-heading')
  assert.ok(heading, 'no workspace heading in the list')
  assert.equal(find(heading, 'btn-label')?.text, 'app')
  assert.equal(heading.attributes.get('aria-expanded'), 'true')
  // Where the session count used to be. A number told the user what the rows
  // below already say; this is the action they came to the heading for.
  assert.ok(find(root(), 'project-new'), 'the heading row must offer a new session')

  stub.click(heading.node)
  assert.deepEqual(intents, [{ kind: 'toggle-project', projectRoot: '/w/app' }])
})

test('a folded workspace draws its heading and none of its rows', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) }))

  const group = find(root(), 'project-group')
  assert.ok(group?.classes.includes('collapsed'))
  assert.deepEqual(sessionRows(root()), [], 'a folded workspace still drew its sessions')
  // The `+` survives the fold: "new session here" is about the project, not
  // about whichever of its sessions happen to be on screen.
  assert.ok(find(root(), 'project-new'))
  assert.equal(find(root(), 'project-heading')?.attributes.get('aria-expanded'), 'false')
})

test('the heading + creates a session in *its own* project', (t) => {
  // The reason `newSessionIntent` is reached through the model rather than
  // spelled here: `Ctrl+T` resolves the active project and this resolves the one
  // under the cursor, and the two must not disagree about what "new" targets.
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const plus = find(root(), 'project-new')
  assert.ok(plus, 'no + on the heading row')
  stub.click(plus.node)
  assert.deepEqual(intents, [{ kind: 'new', projectRoot: '/w/app' }])
})

test('the + is disabled while a blocking dialog is up', (t) => {
  // Same gate the nav buttons are behind: a control that opens something must
  // not look available while a pane is parked on a permission prompt.
  const { render, root } = mount(t)
  render(viewOf({ ...tieredState(), canCreate: false }))

  assert.equal(find(root(), 'project-new')?.disabled, true)
})

test('right-clicking a heading opens its menu, and the menu item asks first', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const row = find(root(), 'project-row')
  assert.ok(row, 'no heading row to right-click')
  const event = stub.dispatch(row.node, 'contextmenu')
  assert.equal(event.defaultPrevented, true, 'the OS menu must not also open')
  assert.deepEqual(intents, [{ kind: 'open-project-menu', projectRoot: '/w/app' }])

  // The menu is state, so it only exists once the model says so.
  assert.equal(find(root(), 'project-menu'), undefined)
  intents.length = 0
  render(viewOf({ ...tieredState(), projectMenu: '/w/app' }))
  const item = find(root(), 'project-menu-item')
  assert.ok(item, 'the menu drew nothing to click')
  stub.click(item.node)
  assert.deepEqual(intents, [{ kind: 'request-remove-project', projectRoot: '/w/app' }])
})

test('the confirming heading replaces its + with an answer', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingRemoveProject: '/w/app' }))

  assert.equal(find(root(), 'project-new'), undefined, 'the + must not survive the question')
  const yes = find(root(), 'session-confirm-yes')
  const no = find(root(), 'session-confirm-no')
  assert.ok(yes && no)
  stub.click(yes.node)
  stub.click(no.node)
  assert.deepEqual(intents, [
    { kind: 'confirm-remove-project', projectRoot: '/w/app' },
    { kind: 'cancel-remove-project' },
  ])
})

test('the global workspace has no remove menu', (t) => {
  // There is no registry entry to forget, and `isGlobal` comes off the wire —
  // the renderer must not recognize it by matching the display name.
  const { render, root, stub, intents } = mount(t)
  render(
    viewOf({
      projects: [{ projectRoot: '/home/me', projectName: '最近', isGlobal: true, sessions: [] }],
    }),
  )

  const row = find(root(), 'project-row')
  assert.ok(row)
  stub.dispatch(row.node, 'contextmenu')
  assert.deepEqual(intents, [])
})

test('a project with no sessions still draws its heading', (t) => {
  // Deleting the last session used to delete the only way back to the project.
  const { render, root } = mount(t)
  render(viewOf({ projects: [{ projectRoot: '/w/app', projectName: 'app', sessions: [] }] }))

  assert.equal(find(root(), 'project-heading')?.text?.includes('app'), true)
  assert.deepEqual(sessionRows(root()), [])
  assert.ok(find(root(), 'project-empty'), 'an empty group must say it is empty, not look unloaded')
  assert.equal(find(root(), 'sidebar-empty'), undefined, 'this is not the empty state')
})

test('focusProject reaches the heading drawn by the last render', (t) => {
  // The reveal path for the welcome screen's Hero project name. The headings are
  // rebuilt every pass, so this has to read the current one — focusing a node from
  // a previous render would silently do nothing.
  const { render, root, stub, focusProject } = mount(t)
  render(viewOf(tieredState()))
  // A second paint that rebuilds the list, so a heading cached from the first one
  // would now be detached.
  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))

  focusProject('/w/app')
  assert.equal(stub.activeElement(), find(root(), 'project-heading')?.node)

  focusProject('/w/nothing-here')
  assert.equal(
    stub.activeElement(),
    find(root(), 'project-heading')?.node,
    'an unknown project must not move focus',
  )
})

test('a row carries its tier as data — and no tier paints anything', (t) => {
  // `active` is the one the window is showing, `open` is a lane that exists but
  // is not in front, and neither class is history. All three paint identically
  // now — activation is imperceptible by design — but the classes stay: they
  // feed `aria-selected` and the smoke probes, and this is the guard that they
  // still exist on the nodes.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))

  assert.deepEqual(
    sessionRows(root()).map((row) => [
      find(row, 'session-title')?.text,
      row.classes.filter((name) => name !== 'session-row'),
    ]),
    [
      ['正在显示', ['active', 'open']],
      ['后台 lane', ['open']],
      ['只是历史', []],
    ],
  )
})

test('the delete confirmation keeps the name and takes over the actions slot', (t) => {
  // The regression: the confirmation used to replace the whole row, so the one
  // moment the user had to know *which* session they were deleting was the one
  // moment its name was off screen (todo D6).
  const { render, root, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'background' }))

  const row = sessionRows(root()).find((node) => node.classes.includes('confirming'))
  assert.ok(row, 'no row is asking for confirmation')
  assert.ok(row.classes.includes('confirming'))
  assert.equal(find(row, 'session-title')?.text, '后台 lane', 'the name left the row')

  // Disabled, not merely unlistened: a name that still looks clickable invites an
  // answer the row will not give.
  const open = find(row, 'session-open')
  assert.equal(open?.disabled, true)
  stub.click(open?.node)
  assert.deepEqual(intents, [], 'the title answered something while the row was asking')

  const actions = find(row, 'session-actions')
  assert.deepEqual(
    actions?.children.map((child) => child.className),
    ['session-confirm-yes', 'session-confirm-no'],
  )
  stub.click(actions?.children[0]?.node)
  stub.click(actions?.children[1]?.node)
  assert.deepEqual(intents, [
    { kind: 'confirm-delete', projectRoot: '/w/app', sessionId: 'background' },
    { kind: 'cancel-delete' },
  ])
})

test('the first-level actions are rows under the search box', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf())

  const nav = region(root(), 'sidebar-nav')
  assert.deepEqual(nav.children.map((child) => child.text), ['新建会话', '打开项目…'])
  // Rows, not the bordered pills they used to be: they belong to the same column
  // of destinations the session rows are in.
  assert.deepEqual(nav.children.map((child) => child.classes), [
    ['sidebar-nav-item'],
    ['sidebar-nav-item'],
  ])

  stub.click(nav.children[0]?.node)
  stub.click(nav.children[1]?.node)
  assert.deepEqual(intents.map((intent) => intent.kind), ['new', 'open-project'])
})

test('both nav rows are disabled while a blocking dialog is up', (t) => {
  // `canCreate` is false exactly then, and both rows open something.
  const { render, root } = mount(t)
  render(viewOf({ canCreate: false }))

  assert.deepEqual(
    region(root(), 'sidebar-nav').children.map((child) => child.disabled),
    [true, true],
  )
})

test('the chord list is behind the ? and reports a toggle', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf())

  const footer = () => region(root(), 'sidebar-footer')
  assert.equal(
    footer().children.some((child) => child.classes.includes('sidebar-hint')),
    false,
    'the hint is printed under the footer again',
  )

  const help = footer().children
    .find((child) => child.classes.includes('sidebar-footer-row'))
    ?.children.find((child) => child.classes.includes('sidebar-help'))
  assert.ok(help, 'no .sidebar-help in the footer row')
  stub.click(help.node)
  assert.deepEqual(intents, [{ kind: 'toggle-help' }])

  // The click only *reports*; `app.ts` owns the flag, so the panel appears on the
  // next view that carries it.
  render(viewOf({ helpOpen: true }))
  const hint = footer().children.find((child) => child.classes.includes('sidebar-hint'))
  assert.ok(hint, 'the ? panel did not open')
  assert.equal(hint.text, SIDEBAR_HINT)
})

test('a repaint that only flips the help panel is not swallowed by the render guard', (t) => {
  // `sidebarRenderSignature` is the reason this view is affordable, and a field it
  // draws but does not sign goes stale on screen. Verified by mutation: dropping
  // `helpOpen` from the signature reds this and the `?` test above (both open the
  // panel on a second paint), and nothing else in the suite.
  const { render, root } = mount(t)
  render(viewOf())
  render(viewOf({ helpOpen: true }))

  assert.ok(
    region(root(), 'sidebar-footer').children.some((child) => child.classes.includes('sidebar-hint')),
  )
})
