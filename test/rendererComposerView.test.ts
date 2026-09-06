import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createComposerView, type ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import {
  createPermissionRequestView,
  permissionGlyphFor,
} from '../src/desktop/renderer/dom/permissionRequestView.js'
import type { OverlayAction } from '../src/desktop/renderer/model/dialogActions.js'
import type { PermissionViewModel } from '../src/desktop/renderer/model/permissionDialog.js'
import { EFFORT_LABELS, PERMISSION_MODE_LABELS } from '../src/desktop/renderer/model/composer.js'
import { runtimeMenuView, type RuntimeMenuView } from '../src/desktop/renderer/model/runtimeMenu.js'
import { CONTEXT_RATIO_VARIABLE, contextGaugeView } from '../src/desktop/renderer/model/usage.js'
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
  /** The HTML group that puts the gauge beside, not inside, the runtime chip. */
  readonly runtimeShell: HTMLElement
  readonly els: Record<
    | 'input'
    | 'submit'
    | 'stop'
    | 'attach'
    | 'contextIndicator'
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
    contextIndicator: stub.createContainer(),
    chipRuntime: stub.createContainer(),
    chipShell: stub.createContainer(),
    chipPermission: stub.createContainer(),
    permissionShell: stub.createContainer(),
    progress: stub.createContainer(),
  }
  els.permissionShell.appendChild(els.chipPermission)
  const runtimeShell = stub.createContainer()
  runtimeShell.appendChild(els.contextIndicator)
  els.chipShell.appendChild(els.chipRuntime)
  runtimeShell.appendChild(els.chipShell)

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
      contextIndicator: els.contextIndicator,
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
    runtimeShell,
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

test('the context indicator is independent of the chip, and is absent when there is nothing to report', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  assert.equal(r.view('contextIndicator').hidden, true)
  assert.deepEqual(r.view('contextIndicator').children, [])
  assert.deepEqual(
    r.view('chipRuntime').children.map((child) => child.className),
    ['chip-model-label', 'chip-effort-label'],
    'the chip carries the two fields it opens, and nothing else',
  )
  assert.deepEqual(
    r.stub.inspect(r.runtimeShell).children.map((child) => child.node),
    [r.els.contextIndicator, r.els.chipShell],
    'the indicator is the chip shell’s sibling, not its child',
  )

  r.composer.renderRuntime(
    runtime({ contextWindow: 200_000, usableContextWindow: 100_000 }),
    contextGaugeView(90_000, runtime({ usableContextWindow: 100_000 })),
  )
  assert.equal(r.view('contextIndicator').hidden, false)
  assert.deepEqual(
    r.stub.inspect(r.runtimeShell).children.map((child) => child.node),
    [r.els.contextIndicator, r.els.chipShell],
    'the visible indicator stays outside the chip',
  )
  const [gauge, tooltip] = r.view('contextIndicator').children
  assert.equal(gauge?.className, 'context-gauge warn')
  // The ring is decoration; the figures reach the reader through the indicator's
  // own accessible name, which is why the level may be a colour at all.
  assert.equal(gauge?.attributes.get('aria-hidden'), 'true')
  assert.equal(gauge?.styleProperties.get(CONTEXT_RATIO_VARIABLE), '0.9')
  assert.equal(r.view('contextIndicator').attributes.get('role'), 'img')
  assert.match(r.view('contextIndicator').attributes.get('aria-label') ?? '', /90% 已用/)
  assert.equal((r.els.contextIndicator as { title: string }).title, '', 'the hover card is drawn by the renderer, not by the OS')

  assert.equal(tooltip?.classes.includes('context-tooltip'), true)
  assert.equal(tooltip?.attributes.get('role'), 'tooltip')
  assert.equal(tooltip?.attributes.get('aria-hidden'), 'true')
  assert.match(tooltip?.text ?? '', /上下文/)
  assert.match(tooltip?.text ?? '', /90% 已用/)
  assert.match(tooltip?.text ?? '', /90k/)
  assert.match(tooltip?.text ?? '', /100k/)
  assert.doesNotMatch(tooltip?.text ?? '', /模型窗口/, 'this gauge has no separate raw window')
  assert.match(tooltip?.text ?? '', /自动压缩/)

  r.composer.renderRuntime(
    runtime({ contextWindow: 200_000, usableContextWindow: 100_000 }),
    contextGaugeView(90_000, runtime({ contextWindow: 200_000, usableContextWindow: 100_000 })),
  )
  assert.match(r.view('contextIndicator').children[1]?.text ?? '', /模型窗口/)
  assert.match(r.view('contextIndicator').children[1]?.text ?? '', /200k/)
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

// --- the inline permission request -------------------------------------------

/**
 * The permission request moved out of the modal layer and into the capsule
 * (`dom/permissionRequestView.ts`): three of the four blocking requests are
 * still `#overlay`'s, but this one transforms the composer instead.
 *
 * What it *says* is still `model/permissionDialog.ts`'s view model, so nothing
 * about the options is asserted here — only that the card hands back the same
 * `OverlayAction` the modal did, and that showing and hiding leave the composer
 * in the two states it has: a card with no textarea, or a textarea with no card.
 */

function permissionFixture(
  overrides: Partial<PermissionViewModel> = {},
): PermissionViewModel {
  return {
    title: 'Bash 命令',
    subtitle: '需确认 · 权限模式',
    reason: '当前权限模式要求确认。',
    tone: 'normal',
    inputBlock: { kind: 'bash', label: '命令', content: 'rm -rf ./tmp' },
    warnings: [],
    denialStreakNote: undefined,
    options: [
      { label: '允许一次', hotkey: 'y', action: 'allow' },
      { label: '拒绝', hotkey: 'n', action: 'deny' },
    ],
    selectedIndex: 0,
    preview: undefined,
    alsoWaiting: [],
    actions: [
      { label: '允许一次', shortcut: 'Y', role: 'primary', slot: 0 },
      { label: '拒绝', shortcut: 'N', role: 'secondary', slot: 1 },
    ],
    ...overrides,
  }
}

interface Card {
  readonly stub: DomStub
  readonly composer: HTMLElement
  readonly container: HTMLElement
  readonly view: ReturnType<typeof createPermissionRequestView>
  readonly picked: OverlayAction[]
  buttons(): StubView[]
}

function card(t: { after(fn: () => void): void }): Card {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const composer = stub.createContainer('composer')
  const container = stub.createContainer('composer-request')
  const picked: OverlayAction[] = []
  const view = createPermissionRequestView(composer, container, (action) => picked.push(action))
  const buttons = () => {
    const bar = stub.inspect(container).children.find((child) =>
      child.classes.includes('dialog-actions'))
    assert.ok(bar, 'the card ends with the shared button bar')
    return [...bar.children]
  }
  return { stub, composer, container, view, picked, buttons }
}

test('the request transforms the composer rather than covering the lane', (t) => {
  const c = card(t)
  assert.equal(c.stub.inspect(c.container).hidden, true, 'nothing is drawn at rest')

  c.view.show(permissionFixture())

  // The class is what the stylesheet hangs `display: none` for the textarea and
  // the action bar on. Without it the request would be drawn *above* a live
  // composer, which is the modal it replaced with an extra step.
  assert.ok(c.stub.inspect(c.composer).classes.includes('request-open'))
  assert.equal(c.stub.inspect(c.container).hidden, false)
  // The tone is on the card, never on the capsule: the composer's border is a
  // focus affordance, and recolouring it would read as a validation error.
  assert.ok(c.stub.inspect(c.container).classes.includes('tone-normal'))
  assert.equal(c.stub.inspect(c.composer).classes.includes('tone-normal'), false)

  c.view.hide()
  assert.equal(c.stub.inspect(c.composer).classes.includes('request-open'), false)
  assert.equal(c.stub.inspect(c.container).hidden, true)
  // Emptied, not merely hidden: a stale button answers a settled request, and a
  // hidden one is still a Tab stop in some engines.
  assert.equal(c.stub.inspect(c.container).children.length, 0)
})

test('the card answers by slot, exactly as the modal did', (t) => {
  const c = card(t)
  c.view.show(permissionFixture({ selectedIndex: 1 }))

  const [allow, deny] = c.buttons()
  assert.equal(allow!.text, '允许一次Y', 'the label carries its key as a badge')
  assert.ok(allow!.classes.includes('primary'))
  // Where Enter is aimed — on a destructive request the model focuses deny, so
  // this mark is the answer about to be given rather than decoration.
  assert.equal(allow!.classes.includes('selected'), false)
  assert.ok(deny!.classes.includes('selected'))

  c.stub.click(deny!.node)
  c.stub.click(allow!.node)
  assert.deepEqual(c.picked, [{ kind: 'slot', index: 1 }, { kind: 'slot', index: 0 }])
})

test('nothing in the card is a target except its buttons', (t) => {
  const c = card(t)
  c.view.show(permissionFixture({
    denialStreakNote: '已拒绝过一次。',
    alsoWaiting: ['Write'],
  }))

  // The request is holding the agent loop, so there is no dismissing it by
  // clicking beside it — the same rule the modal's backdrop follows.
  for (const child of c.stub.inspect(c.container).children) {
    if (child.classes.includes('dialog-actions')) continue
    c.stub.click(child.node)
  }
  c.stub.click(c.container)
  c.stub.click(c.composer)
  assert.deepEqual(c.picked, [])
})

test('the glyph names what is being asked for, and comes off the input block', (t) => {
  // Read off the block rather than off a tool name: the block is already the
  // projection that knows a Bash request carries a command and a file tool
  // carries a path, and a second list of tool names here would drift from it.
  assert.equal(permissionGlyphFor('bash'), 'terminal')
  assert.equal(permissionGlyphFor('file'), 'file')
  assert.equal(permissionGlyphFor('json'), 'shield')
  assert.equal(permissionGlyphFor('none'), 'shield')
})

test('the capsule holds the card, and the page still has somewhere to put it', () => {
  // Asserted against the page for the reason the composer popovers are: `app.ts`
  // finds both by `getElementById`, so nothing in the renderer would notice the
  // card drifting out of the capsule — only the shape on screen would.
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const start = html.indexOf('<div id="composer">')
  assert.ok(start !== -1, 'the page still has the composer capsule')
  const end = html.indexOf('<div id="status">', start)
  assert.ok(end !== -1, 'the status line still follows the capsule')
  const capsule = html.slice(start, end)

  const request = capsule.indexOf('id="composer-request"')
  assert.ok(request !== -1, 'the request card left the capsule')
  // Before the textarea it replaces, so the request reads top-down where the
  // message being typed used to be.
  assert.ok(request < capsule.indexOf('id="input"'))
  assert.ok(request < capsule.indexOf('id="composer-bar"'))
})

test('an unchanged runtime snapshot rebuilds neither the chip nor the pill', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  const chipBefore = r.view('chipRuntime').children.map((child) => child.node)
  const pillBefore = r.view('chipPermission').children.map((child) => child.node)

  // `renderRuntime` is reached from the snapshot tick, which during a turn fires
  // once per streamed chunk. Identity, not equality: rebuilding a control under
  // the pointer at that rate is what this guard exists to stop.
  for (let tick = 0; tick < 5; tick += 1) r.composer.renderRuntime(runtime())
  assert.deepEqual(r.view('chipRuntime').children.map((child) => child.node), chipBefore)
  assert.deepEqual(r.view('chipPermission').children.map((child) => child.node), pillBefore)

  // A snapshot that moved still repaints, or the guard would be a freeze.
  r.composer.renderRuntime(runtime({ model: 'claude-opus-5', permissionMode: 'plan' }))
  assert.notDeepEqual(r.view('chipRuntime').children.map((child) => child.node), chipBefore)
  assert.equal(r.view('chipRuntime').children[0]!.text, 'claude-opus-5')
  assert.equal(r.view('chipPermission').children[0]!.text, PERMISSION_MODE_LABELS.plan)
})

test('an unchanged context gauge does not rebuild the hover card', (t) => {
  const r = render(t)
  const runtimeSnapshot = runtime({ contextWindow: 200_000, usableContextWindow: 100_000 })
  const gauge = contextGaugeView(90_000, runtimeSnapshot)
  r.composer.renderRuntime(runtimeSnapshot, gauge)
  const before = r.view('contextIndicator').children.map((child) => child.node)

  for (let tick = 0; tick < 5; tick += 1) r.composer.renderRuntime(runtimeSnapshot, gauge)
  assert.deepEqual(
    r.view('contextIndicator').children.map((child) => child.node),
    before,
    'streaming snapshots must not replace a tooltip the pointer is over',
  )

  r.composer.renderRuntime(runtimeSnapshot, contextGaugeView(95_000, runtimeSnapshot))
  assert.notDeepEqual(
    r.view('contextIndicator').children.map((child) => child.node),
    before,
  )
  assert.equal(r.view('contextIndicator').children[0]?.className, 'context-gauge critical')
})

test('the guard does not swallow the click that opens the permission menu', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  assert.equal(r.menuItems().length, 0)

  // The open flag is part of the pill's signature for the same reason
  // `menuOpen` is part of `sidebarRenderSignature`.
  r.stub.click(r.els.chipPermission)
  assert.ok(r.menuItems().length > 0, 'the menu opened')
  r.stub.click(r.els.chipPermission)
  assert.equal(r.menuItems().length, 0, 'and closed again')
})
