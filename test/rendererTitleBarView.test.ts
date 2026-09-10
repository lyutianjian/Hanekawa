import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createTitleBarView } from '../src/desktop/renderer/dom/titleBarView.js'
import {
  TITLE_BAR_MENUS,
  itemEnabled,
  toggleMenu,
  type TitleBarAction,
  type TitleBarView,
} from '../src/desktop/renderer/model/titleBar.js'

/**
 * The frameless window's title bar (5g).
 *
 * The claim worth pinning is not that a menu opens — it is that **every item maps
 * to an action the app already had**. The bar exists because Electron's default
 * menu is English and the window has no frame to hang it on; if an item ever
 * grows behaviour of its own, this is the layer where two ways to do one thing
 * start disagreeing.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly actions: TitleBarAction[]
  readonly menuRequests: Array<string | undefined>
  render(view: TitleBarView): void
  root(): StubView
}

function viewOf(overrides: Partial<TitleBarView> = {}): TitleBarView {
  return {
    menus: TITLE_BAR_MENUS,
    openMenu: undefined,
    sidebarCollapsed: false,
    canCreate: true,
    ...overrides,
  }
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('titlebar')
  const actions: TitleBarAction[] = []
  const menuRequests: Array<string | undefined> = []
  const dom = createTitleBarView(
    container,
    (action) => actions.push(action),
    (id) => menuRequests.push(id),
  )
  return {
    stub,
    container,
    actions,
    menuRequests,
    render: (view) => dom.render(view),
    root: () => stub.inspect(container),
  }
}

const shells = (root: StubView): readonly StubView[] =>
  root.children.filter((child) => child.classes.includes('titlebar-menu-shell'))

const openList = (root: StubView): StubView | undefined =>
  shells(root)
    .flatMap((shell) => shell.children)
    .find((child) => child.classes.includes('titlebar-menu') && !child.hidden && !child.classes.includes('presence-closing'))

test('the bar is the rail toggle and the three Chinese menus, in that order', (t) => {
  const { render, root, stub, actions } = mount(t)
  render(viewOf())

  const children = root().children
  assert.ok(children[0]?.classes.includes('titlebar-rail'))
  assert.deepEqual(
    shells(root()).map((shell) => shell.children[0]?.text),
    ['文件', '视图', '帮助'],
  )

  stub.click(children[0]?.node)
  assert.deepEqual(actions, ['toggle-sidebar'])
})

test('a trigger reports the menu it wants open, and the view draws it on the next render', (t) => {
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf())

  assert.equal(openList(root()), undefined, 'a menu is drawn before anything asked for one')
  stub.click(shells(root())[0]?.children[0]?.node)
  assert.deepEqual(menuRequests, ['file'])

  render(viewOf({ openMenu: 'file' }))
  const items = openList(root())?.children ?? []
  assert.deepEqual(items.map((item) => item.text), [
    '新建会话Ctrl+T',
    '打开项目…Ctrl+Shift+O',
    '设置Ctrl+,',
  ])
})

test('choosing an item closes the menu before it acts', (t) => {
  // Several of these swap the whole canvas; a menu left open would hang over the
  // screen that replaced it. The order is the claim, so both lists are asserted.
  const { render, root, stub, actions, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'file' }))

  stub.click(openList(root())?.children[2]?.node)
  assert.deepEqual(menuRequests, [undefined])
  assert.deepEqual(actions, ['open-settings'])
})

test('the two items that open something are dead while a blocking dialog is up', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ openMenu: 'file', canCreate: false }))

  assert.deepEqual(
    openList(root())?.children.map((item) => item.disabled),
    [true, true, false],
    'settings is window-level and stays reachable',
  )
})

test('focus leaving the bar closes an open menu; focus moving inside does not', (t) => {
  const { render, root, container, stub, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'view' }))

  const inside = openList(root())?.children[0]?.node
  stub.dispatch(container, 'focusout', { relatedTarget: inside })
  assert.deepEqual(menuRequests, [], 'focus inside the bar closed the menu')

  // `null` is this view's own repaint destroying the focused node, not a
  // departure — the same carve-out `sidebarView.ts` makes.
  stub.dispatch(container, 'focusout', { relatedTarget: null })
  assert.deepEqual(menuRequests, [])

  stub.dispatch(container, 'focusout', { relatedTarget: stub.createContainer('elsewhere') })
  assert.deepEqual(menuRequests, [undefined])
})

test('a press outside the bar closes an open menu, and only then', (t) => {
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf())

  const elsewhere = stub.createContainer('canvas')
  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(menuRequests, [], 'a press with nothing open must not cost a repaint')

  render(viewOf({ openMenu: 'view' }))
  stub.dispatchDocument('pointerdown', { target: openList(root())?.children[0]?.node })
  assert.deepEqual(menuRequests, [], 'a press on the menu itself is the user using it')

  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(menuRequests, [undefined])
})

test('the bar’s own blank strip is outside the menu', (t) => {
  // The scope is each menu shell, not the strip they sit on: pressing the empty
  // space beside 帮助 while a menu hangs under 文件 is a dismissal, and a
  // bar-wide scope used to read it as a press inside the thing being dismissed.
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'view' }))

  stub.dispatchDocument('pointerdown', { target: root().node })
  assert.deepEqual(menuRequests, [undefined])
})

test('Escape closes an open menu and only then', (t) => {
  const { render, container, stub, menuRequests } = mount(t)
  render(viewOf())

  stub.dispatch(container, 'keydown', { key: 'Escape' })
  assert.deepEqual(menuRequests, [], 'Escape with nothing open must reach the app, not be eaten')

  render(viewOf({ openMenu: 'help' }))
  stub.dispatch(container, 'keydown', { key: 'Escape' })
  assert.deepEqual(menuRequests, [undefined])
})

test('every item names an action the model can enable, and toggling is idempotent', () => {
  // The model half, checked here because it is what the view's contract rests on.
  const view = viewOf({ canCreate: false })
  for (const menu of TITLE_BAR_MENUS) {
    for (const item of menu.items) {
      assert.equal(itemEnabled(item, view), item.needsProject !== true)
    }
  }
  assert.equal(toggleMenu('file', 'file'), undefined)
  assert.equal(toggleMenu('file', 'view'), 'view')
  assert.equal(toggleMenu(undefined, 'help'), 'help')
})
