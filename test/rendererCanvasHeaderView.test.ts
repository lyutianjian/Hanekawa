import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createCanvasHeaderView, type CanvasHeaderDom } from '../src/desktop/renderer/dom/canvasHeaderView.js'
import { canvasHeaderView, type CanvasHeaderMenuItem } from '../src/desktop/renderer/model/canvasHeader.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'

/**
 * The canvas header's *nodes*.
 *
 * The one thing here that cannot be model-tested is also the one most likely to
 * regress: this header repaints on every `onShellChanged` — which includes every
 * snapshot tick of a streaming turn — so the rename field has to survive a
 * `replace()` with its node identity, its value and its caret intact.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

function lane(overrides: Partial<WireLaneInfo> = {}): WireLaneInfo {
  return {
    lane: '1',
    paneId: 's1',
    sessionId: 's1',
    projectRoot: 'c:\\repo\\alpha',
    projectName: 'alpha',
    sessionTitle: '原标题',
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly header: CanvasHeaderDom
  readonly container: HTMLElement
  readonly events: string[]
  readonly renamed: string[]
  /** Renders from the real model, so the view is never fed a shape it cannot get. */
  paint(state: {
    lane?: WireLaneInfo | undefined
    menuOpen?: boolean
    renaming?: boolean
    pendingDelete?: string
  }): void
  identity(): StubView
  titleNode(): StubView | undefined
  menuItems(): StubView[]
  openLocation(): StubView | undefined
}

function render(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())

  const container = stub.createContainer('canvas-header')
  const events: string[] = []
  const renamed: string[] = []
  const header = createCanvasHeaderView(container, {
    onToggleMenu: () => events.push('toggle-menu'),
    onCloseMenu: () => events.push('close-menu'),
    onMenuItem: (id: CanvasHeaderMenuItem['id']) => events.push(`item:${id}`),
    onRename: (title) => renamed.push(title),
    onCancelRename: () => events.push('cancel-rename'),
    onOpenLocation: () => events.push('open-location'),
  })

  const identity = () =>
    stub.inspect(container).children.find((child) => child.classes.includes('canvas-identity'))!
  const find = (view: StubView | undefined, className: string): StubView | undefined =>
    view?.children.find((child) => child.classes.includes(className))

  return {
    stub,
    header,
    container,
    events,
    renamed,
    paint(state) {
      header.render(canvasHeaderView({
        lane: 'lane' in state ? state.lane : lane(),
        menuOpen: state.menuOpen ?? false,
        renaming: state.renaming ?? false,
        pendingDelete: state.pendingDelete,
        // Every case here is about a conversation on screen; the draft case (no
        // header at all) is a model decision and is asserted there.
        hasConversation: true,
      }))
    },
    identity,
    titleNode: () =>
      identity().children.find(
        (child) => child.classes.includes('canvas-title') || child.classes.includes('canvas-title-input'),
      ),
    menuItems: () => {
      const shell = find(identity(), 'canvas-menu-shell')
      const menu = find(shell, 'canvas-menu')
      return [...(menu?.children ?? [])]
    },
    openLocation: () =>
      find(
        stub.inspect(container).children.find((child) => child.classes.includes('canvas-header-controls')),
        'canvas-open-location',
      ),
  }
}

test('an empty window draws nothing rather than the last session it had', (t) => {
  const r = render(t)
  r.paint({})
  assert.equal(r.stub.inspect(r.container).hidden, false)

  r.paint({ lane: undefined })

  assert.equal(r.stub.inspect(r.container).hidden, true)
  assert.equal(r.identity, r.identity, 'identity is still addressable')
  assert.equal(r.stub.inspect(r.container).text, '', 'a stale title would be a lie about which session is open')
})

test('the header shows the title and the two right-hand controls', (t) => {
  const r = render(t)
  r.paint({})

  assert.equal(r.titleNode()?.text, '原标题')
  assert.equal(r.openLocation()?.text.includes('打开位置'), true)
  // `button()` puts the same string on `title` and `aria-label`; the attribute is
  // the one a screen reader reads, so that is the one asserted.
  assert.equal(r.openLocation()?.attributes.get('aria-label')?.includes('alpha'), true)

  r.stub.click(r.openLocation()!.node)
  assert.deepEqual(r.events, ['open-location'])
})

test('the menu is built only when open, and its items report by id', (t) => {
  const r = render(t)
  r.paint({})
  assert.deepEqual(r.menuItems(), [], 'a closed menu is absent, not hidden')

  r.paint({ menuOpen: true })
  assert.deepEqual(r.menuItems().map((item) => item.text), ['重命名', '删除会话'])
  r.stub.click(r.menuItems()[1]!.node)
  assert.deepEqual(r.events, ['item:delete'])

  r.paint({ menuOpen: true, pendingDelete: 's1' })
  assert.deepEqual(r.menuItems().map((item) => item.text), ['确认删除', '取消'])
})

test('the rename field survives the repaints a streaming turn causes', (t) => {
  // The header repaints on every `onShellChanged`. A field rebuilt inside
  // `replace()` would lose the caret — and the half-typed title — mid-word.
  const r = render(t)
  r.paint({})
  r.paint({ renaming: true })

  const field = r.titleNode()!
  assert.equal(field.classes.includes('canvas-title-input'), true)
  assert.equal(r.stub.activeElement(), field.node, 'the field takes focus when it appears')

  const input = field.node as { value: string }
  input.value = '用户正在打的字'
  r.paint({ renaming: true })

  assert.equal(r.titleNode()?.node, field.node, 'the same node, not a rebuilt one')
  assert.equal(input.value, '用户正在打的字', 'and it was not written back over')
})

test('Enter commits a real change; Escape and a no-op change do not', (t) => {
  const r = render(t)
  r.paint({ renaming: true })
  const input = r.titleNode()!.node as { value: string }

  input.value = '  新标题  '
  r.stub.dispatch(r.titleNode()!.node, 'keydown', { key: 'Enter' })
  assert.deepEqual(r.renamed, ['新标题'], 'trimmed on the way out')

  r.paint({ renaming: true })
  r.stub.dispatch(r.titleNode()!.node, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.renamed, ['新标题'])
  assert.equal(r.events.includes('cancel-rename'), true)
})

test('blurring an untouched field cancels instead of writing the index', (t) => {
  // `rename-session` writes the index and broadcasts to every lane; clicking
  // away from a field the user never typed into must not cost that.
  const r = render(t)
  r.paint({ renaming: true })

  r.stub.dispatch(r.titleNode()!.node, 'blur')

  assert.deepEqual(r.renamed, [])
  assert.deepEqual(r.events, ['cancel-rename'])
})

test('focus leaving the header closes the menu; moving inside it does not', (t) => {
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatch(r.container, 'focusout', { relatedTarget: r.menuItems()[0]!.node })
  assert.deepEqual(r.events, [], 'focus moving between the trigger and an item is not leaving')

  r.stub.dispatch(r.container, 'focusout', { relatedTarget: null })
  assert.deepEqual(r.events, ['close-menu'])
})
