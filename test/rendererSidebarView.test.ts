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
 * means. What only shows up here is the 5g shape: the header carries the
 * workspace and the rail toggle and *nothing else* (a third control there is what
 * truncated the project name to `Hanekawa-…`), the first-level actions are rows
 * under the search box, and the chord list lives behind the footer's `?` instead
 * of being printed under it.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: SidebarIntent[]
  render(view: SidebarView): void
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

test('the header is the workspace and nothing else', (t) => {
  // Two regressions in one assertion. "New session" used to sit here as a second
  // control, and at the sidebar's width that is what left room for `Hanekawa-…`
  // instead of the project's name (design_guidance 三.2); the rail toggle was the
  // third of three ways to collapse the sidebar, and the spec names the title
  // bar's (三.1) — so it is gone from here entirely (todo D8).
  const { render, root } = mount(t)
  render(viewOf())

  const header = region(root(), 'sidebar-header')
  assert.deepEqual(header.children.map((child) => child.className), ['sidebar-workspace-shell'])
  assert.equal(find(root(), 'sidebar-collapse'), undefined, 'the sidebar grew a second collapse control')

  // 「项目名 + `⌵`」 (design_guidance 三.2): the caret follows the name rather
  // than leading it, which is also what lets the name be the part that truncates
  // (todo V4). Verified by mutation: `trailingIcon` back to `icon` reds this.
  const trigger = find(root(), 'sidebar-workspace')
  assert.ok(trigger, 'the workspace trigger is gone')
  assert.equal(trigger.children[0]?.className, 'btn-label')
  assert.equal(trigger.children.at(-1)?.tagName, 'svg')
})

test('collapsing hides every region, the header included', (t) => {
  // The rail survived only so this view's own toggle stayed clickable. With that
  // toggle in the title bar, a collapsed sidebar is zero width — and a header
  // still drawn would be what keeps the column from reaching it.
  const { render, root } = mount(t)
  render(viewOf({ collapsed: true }))

  for (const name of ['sidebar-header', 'sidebar-search', 'sidebar-nav', 'sidebar-list', 'sidebar-footer']) {
    assert.equal(region(root(), name).hidden, true, `.${name} is still on screen while collapsed`)
  }
})

test('a row says which of the three tiers it is in', (t) => {
  // `active` is the one the window is showing, `open` is a lane that exists but
  // is not in front, and neither class is history. Before 5h every open row read
  // identically, so the visible one could not be picked out of five (todo D5).
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
