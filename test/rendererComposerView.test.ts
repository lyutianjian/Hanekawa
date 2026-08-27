import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createComposerView, type ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import { EFFORT_LABELS, PERMISSION_MODE_LABELS } from '../src/desktop/renderer/model/composer.js'
import { runtimeMenuView, type RuntimeMenuView } from '../src/desktop/renderer/model/runtimeMenu.js'
import type { SurfaceAction } from '../src/desktop/renderer/model/surfaces.js'
import type { PermissionMode } from '../src/harness/permissions.js'
import type { WireModelsResult, WireRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The composer's *nodes* — the half `rendererComposerChip.test.ts` cannot reach.
 *
 * Three things here are not model decisions and so have nowhere else to be
 * tested: the permission menu's open flag lives in this view (the composer is a
 * singleton with no reducer behind it), `focusout` has to tell "the user left"
 * from "this view repainted", and the send button's classes are recomputed on a
 * keystroke rather than on a render call.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

const RENDERER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'desktop',
  'renderer',
)

function runtime(overrides: Partial<WireRuntimeSnapshot> = {}): WireRuntimeSnapshot {
  return {
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly composer: ComposerView
  readonly els: Record<
    | 'input'
    | 'submit'
    | 'stop'
    | 'attach'
    | 'chipRuntime'
    | 'chipShell'
    | 'chipPermission'
    | 'permissionShell'
    | 'progress',
    HTMLElement
  >
  readonly picked: PermissionMode[]
  readonly attaches: number[]
  /** Every `onOpenRuntimeMenu`, so "asked once" is assertable. */
  readonly menuRequests: number[]
  /** The `SurfaceAction`s a flyout row handed back. */
  readonly ran: SurfaceAction[]
  view(name: keyof Rendered['els']): StubView
  /** The permission menu's items, or an empty list when it is closed. */
  menuItems(): StubView[]
  /** The chip popover's two rows, or an empty list when it is shut. */
  chipRows(): StubView[]
  /** The open flyout's option items, or an empty list when none is open. */
  flyoutItems(): StubView[]
}

/** The textarea, typed for the one member a test writes. */
function input(r: Rendered): { value: string } {
  return r.els.input as unknown as { value: string }
}

function render(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())

  const els = {
    input: stub.createContainer(),
    submit: stub.createContainer(),
    stop: stub.createContainer(),
    attach: stub.createContainer(),
    chipRuntime: stub.createContainer(),
    chipShell: stub.createContainer(),
    chipPermission: stub.createContainer(),
    permissionShell: stub.createContainer(),
    progress: stub.createContainer(),
  }
  els.permissionShell.appendChild(els.chipPermission)
  els.chipShell.appendChild(els.chipRuntime)

  const picked: PermissionMode[] = []
  const attaches: number[] = []
  const menuRequests: number[] = []
  const ran: SurfaceAction[] = []
  const composer = createComposerView(
    {
      input: els.input as HTMLTextAreaElement,
      submit: els.submit as HTMLButtonElement,
      stop: els.stop as HTMLButtonElement,
      attach: els.attach as HTMLButtonElement,
      chipRuntime: els.chipRuntime as HTMLButtonElement,
      chipShell: els.chipShell,
      chipPermission: els.chipPermission as HTMLButtonElement,
      permissionShell: els.permissionShell,
      progress: els.progress,
    },
    {
      onOpenRuntimeMenu: () => menuRequests.push(1),
      onRuntimeAction: (action) => ran.push(action),
      onSelectPermissionMode: (mode) => picked.push(mode),
      onAttach: () => attaches.push(1),
    },
  )

  const menu = (): StubView | undefined =>
    stub.inspect(els.permissionShell).children.find((child) => child.classes.includes('composer-menu'))
  const chipMenu = (): StubView | undefined =>
    stub.inspect(els.chipShell).children.find((child) => child.classes.includes('chip-menu'))
  const flyout = (): StubView | undefined =>
    chipMenu()
      ?.children.flatMap((shell) => [...shell.children])
      .find((child) => child.classes.includes('chip-flyout'))

  return {
    stub,
    composer,
    els,
    picked,
    attaches,
    menuRequests,
    ran,
    view: (name) => stub.inspect(els[name]),
    menuItems: () => [...(menu()?.children ?? [])],
    // The row is the shell's first child; the flyout, when open, is its second.
    chipRows: () => (chipMenu()?.children ?? []).map((shell) => shell.children[0]!),
    flyoutItems: () =>
      (flyout()?.children ?? []).filter((child) => child.classes.includes('chip-flyout-item')),
  }
}

const MODELS: WireModelsResult = {
  models: [],
  pickerOptions: [
    { key: 'sonnet', label: 'Sonnet', modelKey: 'sonnet', modelId: 'claude-sonnet-5', isCurrent: true, isDefault: true },
    { key: 'opus', label: 'Opus', modelKey: 'opus', modelId: 'claude-opus-5', isCurrent: false, isDefault: false },
  ],
}

/** The chip popover's rows, built the way the pane builds them. */
function menuView(snapshot: WireRuntimeSnapshot = runtime()): RuntimeMenuView {
  return runtimeMenuView({ runtime: snapshot, models: MODELS })
}

/** What the pane hands over before the first snapshot: nothing to switch. */
function inertMenuView(): RuntimeMenuView {
  return runtimeMenuView({ runtime: undefined, models: MODELS })
}

test('the pill is disabled and menuless until a snapshot arrives', (t) => {
  const r = render(t)
  assert.equal(r.view('chipPermission').disabled, true)

  // A click on an inert pill must not open anything: the menu would list four
  // modes with no current one and act on a runtime that does not exist yet.
  r.stub.click(r.els.chipPermission)
  assert.deepEqual(r.menuItems(), [])
})

test('the pill opens a menu of the four modes and marks the live one', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime({ permissionMode: 'acceptEdits' }))
  assert.equal(r.view('chipPermission').text, PERMISSION_MODE_LABELS.acceptEdits)

  r.stub.click(r.els.chipPermission)
  const items = r.menuItems()
  assert.deepEqual(items.map((item) => item.text), [
    PERMISSION_MODE_LABELS.default,
    PERMISSION_MODE_LABELS.acceptEdits,
    PERMISSION_MODE_LABELS.plan,
    PERMISSION_MODE_LABELS.bypass,
  ])
  assert.deepEqual(
    items.filter((item) => item.classes.includes('active')).map((item) => item.text),
    [PERMISSION_MODE_LABELS.acceptEdits],
  )
  assert.equal(r.view('chipPermission').attributes.get('aria-expanded'), 'true')
})

test('choosing a mode reports it once and closes the menu', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.stub.click(r.menuItems()[2]!.node)

  assert.deepEqual(r.picked, ['plan'])
  assert.deepEqual(r.menuItems(), [], 'the menu closes on its own, not on the snapshot coming back')
  // The label is *not* updated locally: the host posts a fresh runtime snapshot,
  // and guessing here would show a mode the gate may have refused.
  assert.equal(r.view('chipPermission').text, PERMISSION_MODE_LABELS.default)
})

test('Escape and focus leaving both close the menu; focus moving inside does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.stub.click(r.els.chipPermission)
  r.stub.dispatch(r.els.permissionShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.menuItems(), [])

  r.stub.click(r.els.chipPermission)
  // Focus moving between the trigger and an item is not "the user left" — the
  // browser fires `focusout` for that too, and closing there would make the menu
  // impossible to click.
  r.stub.dispatch(r.els.permissionShell, 'focusout', { relatedTarget: r.menuItems()[0]!.node })
  assert.equal(r.menuItems().length, 4)

  r.stub.dispatch(r.els.permissionShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.menuItems(), [])
})

test('a background pane cannot leave its menu hanging over the next one', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.composer.closeMenus()

  assert.deepEqual(r.menuItems(), [])
})

// --- the chip's popover --------------------------------------------------------

test('the chip is one label carrying both fields, inert until a snapshot arrives', (t) => {
  const r = render(t)
  assert.equal(r.view('chipRuntime').disabled, true)

  r.composer.renderRuntime(runtime())
  assert.deepEqual(
    r.view('chipRuntime').children.map((child) => [child.className, child.text]),
    [['chip-model-label', 'claude-sonnet-5'], ['chip-effort-label', EFFORT_LABELS.high]],
  )
  assert.equal(r.view('chipRuntime').disabled, false)
})

test('clicking the chip asks the pane for the rows rather than opening anything', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.stub.click(r.els.chipRuntime)
  assert.deepEqual(r.menuRequests, [1])
  assert.deepEqual(r.chipRows(), [], 'nothing is drawn until the rows come back')

  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows().map((row) => row.text), [
    `模型claude-sonnet-5`,
    `推理强度${EFFORT_LABELS.high}`,
  ])
  assert.equal(r.view('chipRuntime').attributes.get('aria-expanded'), 'true')
  // The popover opens as its two rows and nothing else. Focus lands on the first
  // one, and a flyout on focus would put the model list over the menu the user
  // has not read yet.
  assert.deepEqual(r.flyoutItems(), [])
  r.stub.dispatch(r.chipRows()[0]!.node, 'focus')
  assert.deepEqual(r.flyoutItems(), [])
})

test('an answer nobody asked for is dropped', (t) => {
  // The rows are a round trip, so one can land after the pane went to the
  // background — which would hang a menu over the *next* pane's runtime.
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows(), [])

  r.stub.click(r.els.chipRuntime)
  r.composer.closeMenus()
  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows(), [], 'closing the menus also withdraws the request')
})

test('a snapshotless menu refuses to open, and the next click asks again', (t) => {
  const r = render(t)
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(inertMenuView())

  assert.deepEqual(r.chipRows(), [])
  r.stub.click(r.els.chipRuntime)
  assert.deepEqual(r.menuRequests, [1, 1], 'the second click asks, it does not read as "close"')
})

test('hovering a row opens its flyout, and only one is open at a time', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  const [model, effort] = r.chipRows()
  r.stub.dispatch(effort!.node, 'mouseenter')
  assert.deepEqual(
    r.flyoutItems().map((item) => item.children[0]!.text),
    [EFFORT_LABELS.low, EFFORT_LABELS.medium, EFFORT_LABELS.high, EFFORT_LABELS.xhigh, EFFORT_LABELS.max],
  )
  // The level in force is marked, and the row it is on says so to a reader.
  assert.deepEqual(
    r.flyoutItems().filter((item) => item.classes.includes('active')).map((item) => item.children[0]!.text),
    [EFFORT_LABELS.high],
  )

  r.stub.dispatch(model!.node, 'mouseenter')
  assert.deepEqual(r.flyoutItems().map((item) => item.children[0]!.text), ['Sonnet', 'Opus'])
  assert.equal(r.chipRows().filter((row) => row.classes.includes('open')).length, 1)
})

test('re-entering the row a flyout already belongs to does not rebuild it', (t) => {
  // The rows are kept across a flyout change on purpose: rebuilding one under
  // the pointer fires `mouseenter` on the replacement, and the render loop that
  // follows has no exit.
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  const row = r.chipRows()[1]!
  r.stub.dispatch(row.node, 'mouseenter')
  const first = r.flyoutItems()[0]!.node
  r.stub.dispatch(row.node, 'mouseenter')

  assert.equal(r.flyoutItems()[0]!.node, first)
  assert.equal(r.chipRows()[1]!.node, row.node)
})

test('choosing a level runs its command once and shuts the popover', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  r.stub.click(r.flyoutItems()[0]!.node)

  // The slash command, not `set-effort`: that is what writes the choice back to
  // config (`model/surfaces.ts`).
  assert.deepEqual(r.ran, [{ kind: 'run-command', line: '/effort low' }])
  assert.deepEqual(r.chipRows(), [])
  assert.equal(r.view('chipRuntime').attributes.get('aria-expanded'), 'false')
})

test('a level over the model’s ceiling explains itself instead of being pickable', (t) => {
  const r = render(t)
  const snapshot = runtime({ effort: 'medium', maxEffort: 'high' })
  r.composer.renderRuntime(snapshot)
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView(snapshot))
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  const over = r.flyoutItems().filter((item) => item.classes.includes('disabled'))
  assert.deepEqual(over.map((item) => item.children[0]!.text), [EFFORT_LABELS.xhigh, EFFORT_LABELS.max])
  assert.equal(over[0]!.disabled, true)
  r.stub.click(over[0]!.node)
  assert.deepEqual(r.ran, [], 'a disabled row is drawn to explain itself, not to be picked')
})

test('Escape closes the flyout first and the popover second', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  const first = r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'Escape' })
  assert.equal(first.defaultPrevented, true, 'consumed here, or it also closes a surface behind the composer')
  assert.deepEqual(r.flyoutItems(), [])
  assert.equal(r.chipRows().length, 2, 'the popover itself is still open')

  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.chipRows(), [])
  assert.equal(r.stub.activeElement(), r.els.chipRuntime)
})

test('focus leaving the chip shell closes the popover; moving inside it does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  r.stub.dispatch(r.els.chipShell, 'focusout', { relatedTarget: r.chipRows()[0]!.node })
  assert.equal(r.chipRows().length, 2)

  r.stub.dispatch(r.els.chipShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.chipRows(), [])
})

test('the send button is idle when empty, ready when typed into', (t) => {
  const r = render(t)
  assert.deepEqual(r.view('submit').classes.includes('idle'), true)

  input(r).value = 'hello'
  // Through the event, not through a method: this is the path a keystroke takes.
  r.stub.dispatch(r.els.input, 'input')
  assert.deepEqual(r.view('submit').classes, ['ready'])

  input(r).value = '   '
  r.stub.dispatch(r.els.input, 'input')
  assert.deepEqual(r.view('submit').classes, ['idle'], 'whitespace is not a message')
})

test('a programmatic edit updates the button too', (t) => {
  // A restored draft (`restoreInput`) fires no `input` event, and a button left
  // reading "idle" would be the only thing on screen saying there is nothing to send.
  const r = render(t)
  r.composer.setValue('recovered draft', 5)
  assert.deepEqual(r.view('submit').classes, ['ready'])

  r.composer.clear()
  assert.deepEqual(r.view('submit').classes, ['idle'])
})

test('streaming turns the ring on and keeps the button enabled and queueing', (t) => {
  const r = render(t)
  input(r).value = 'next message'
  r.stub.dispatch(r.els.input, 'input')

  r.composer.setStreaming(true)

  assert.deepEqual(r.view('submit').classes, ['streaming'])
  assert.equal(r.view('progress').hidden, false)
  assert.equal(r.view('stop').hidden, false, 'stop appears beside it, not instead of it')
  // Enabled in every state: `requestSubmit()` ignores a disabled button, so the
  // click would vanish with no error anywhere.
  assert.equal(r.view('submit').disabled, false)
  assert.equal(r.view('submit').attributes.get('aria-label'), '加入队列')

  r.composer.setStreaming(false)
  assert.deepEqual(r.view('submit').classes, ['ready'])
  assert.equal(r.view('progress').hidden, true)
  assert.equal(r.view('stop').hidden, true)
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const r = render(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'composerView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(r.stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})
