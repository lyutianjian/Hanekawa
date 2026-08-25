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

test('the header is the workspace and the rail toggle, and nothing else', (t) => {
  // The regression this pins: "new session" used to sit here as a third control,
  // and at the sidebar's width that is what left room for `Hanekawa-…` instead of
  // the project's name (design_guidance 三.2).
  const { render, root } = mount(t)
  render(viewOf())

  const header = region(root(), 'sidebar-header')
  assert.deepEqual(
    header.children.map((child) => child.className),
    ['sidebar-workspace-shell', 'sidebar-collapse'],
  )
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
