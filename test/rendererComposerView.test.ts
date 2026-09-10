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
  /** The bar the `+` lives in; its menu is drawn into it. */
  readonly attachShell: HTMLElement
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
    | 'progress'
    | 'attachStrip',
    HTMLElement
  >
  readonly picked: PermissionMode[]
  readonly attaches: number[]
  /** Every `onOpenRuntimeMenu`, so "asked once" is assertable. */
  readonly menuRequests: number[]
  /** The `SurfaceAction`s a flyout row handed back. */
  readonly ran: SurfaceAction[]
  readonly pickedImages: number[]
  readonly removedDrafts: string[]
  readonly retriedDrafts: string[]
  readonly openedDrafts: string[]
  readonly previewedDrafts: string[]
  readonly pastedFiles: File[][]
  view(name: keyof Rendered['els']): StubView
  /** The permission menu's items, or an empty list when it is closed. */
  menuItems(): StubView[]
  /** The `+` menu's two items, or an empty list when it is closed. */
  attachMenuItems(): StubView[]
  /** The strip's rows, as views. */
  attachmentRows(): StubView[]
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
    attachStrip: stub.createContainer(),
  }
  els.permissionShell.appendChild(els.chipPermission)
  const attachShell = stub.createContainer()
  attachShell.appendChild(els.attach)
  const runtimeShell = stub.createContainer()
  runtimeShell.appendChild(els.contextIndicator)
  els.chipShell.appendChild(els.chipRuntime)
  runtimeShell.appendChild(els.chipShell)

  const picked: PermissionMode[] = []
  const attaches: number[] = []
  const menuRequests: number[] = []
  const ran: SurfaceAction[] = []
  const pickedImages: number[] = []
  const removedDrafts: string[] = []
  const retriedDrafts: string[] = []
  const openedDrafts: string[] = []
  const previewedDrafts: string[] = []
  const pastedFiles: File[][] = []
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
      attachStrip: els.attachStrip,
    },
    {
      onOpenRuntimeMenu: () => menuRequests.push(1),
      onRuntimeAction: (action) => ran.push(action),
      onSelectPermissionMode: (mode) => picked.push(mode),
      onAttach: () => attaches.push(1),
      onPickImages: () => pickedImages.push(1),
      onRemoveAttachment: (draftId) => removedDrafts.push(draftId),
      onRetryAttachment: (draftId) => retriedDrafts.push(draftId),
      onOpenAttachment: (draftId) => openedDrafts.push(draftId),
      onPreviewAttachment: (draftId) => previewedDrafts.push(draftId),
      onPasteImages: (files) => pastedFiles.push([...files]),
    },
  )

  const menu = (): StubView | undefined =>
    stub.inspect(els.permissionShell).children.find((child) => child.classes.includes('composer-menu') && child.attributes.get('aria-hidden') !== 'true')
  const attachMenu = (): StubView | undefined =>
    stub.inspect(attachShell).children.find((child) => child.classes.includes('composer-menu') && child.attributes.get('aria-hidden') !== 'true')
  const chipMenu = (): StubView | undefined =>
    stub.inspect(els.chipShell).children.find((child) => child.classes.includes('chip-menu') && child.attributes.get('aria-hidden') !== 'true')
  const flyout = (): StubView | undefined =>
    chipMenu()
      ?.children.flatMap((shell) => [...shell.children])
      .find((child) => child.classes.includes('chip-flyout') && child.attributes.get('aria-hidden') !== 'true')

  return {
    stub,
    composer,
    runtimeShell,
    attachShell,
    els,
    picked,
    attaches,
    menuRequests,
    ran,
    pickedImages,
    removedDrafts,
    retriedDrafts,
    openedDrafts,
    previewedDrafts,
    pastedFiles,
    view: (name) => stub.inspect(els[name]),
    menuItems: () => [...(menu()?.children ?? [])],
    attachMenuItems: () => [...(attachMenu()?.children ?? [])],
    attachmentRows: () => [...stub.inspect(els.attachStrip).children],
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

test('a press outside the pill closes the permission menu; inside it does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.stub.dispatchDocument('pointerdown', { target: r.menuItems()[0]!.node })
  assert.equal(r.menuItems().length, 4, 'choosing a mode is not leaving')

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.menuItems(), [])
})

test('a press outside the chip shell closes the runtime popover', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  r.stub.dispatchDocument('pointerdown', { target: r.chipRows()[0]!.node })
  assert.equal(r.chipRows().length, 2)

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.chipRows(), [])
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

test('a level the model does not support explains itself instead of being pickable', (t) => {
  const r = render(t)
  const snapshot = runtime({ effort: 'medium', supportedEfforts: ['low', 'medium', 'high'] })
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
  assert.deepEqual(
    r.view('contextIndicator').children.map((child) => child.node),
    before,
  )
  assert.match(r.view('contextIndicator').text, /95%/)
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

test('permission menu exit is inert and reverses on the same node', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)
  const menu = r.view('permissionShell').children.find((node) => node.classes.includes('permission-menu'))!.node
  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.equal(r.stub.inspect(menu).classes.includes('presence-closing'), true)
  assert.equal(r.stub.inspect(menu).attributes.has('inert'), true)
  assert.equal(r.stub.activeElement(), r.els.chipPermission)
  r.stub.click(r.els.chipPermission)
  assert.equal(r.view('permissionShell').children.find((node) => node.classes.includes('permission-menu'))!.node, menu)
  assert.equal(r.stub.inspect(menu).classes.includes('presence-entering'), true)
  assert.equal(r.stub.inspect(menu).attributes.has('inert'), false)
  r.composer.closeMenus()
  assert.equal(r.stub.inspect(menu).hidden, true, 'pane deactivation settles visual exits')
})

test('tooltip Escape exits while the indicator stays hovered and values retain identity', (t) => {
  const r = render(t)
  const snapshot = runtime({ usableContextWindow: 100_000 })
  r.composer.renderRuntime(snapshot, contextGaugeView(40_000, snapshot))
  r.stub.dispatch(r.els.contextIndicator, 'mouseenter')
  const tooltip = r.view('contextIndicator').children[1]!.node
  r.stub.dispatch(tooltip, 'transitionend', { propertyName: 'opacity' })
  r.composer.renderRuntime(snapshot, contextGaugeView(45_000, snapshot))
  assert.equal(r.view('contextIndicator').children[1]!.node, tooltip)
  assert.equal(r.stub.inspect(tooltip).classes.includes('presence-open'), true)
  r.stub.dispatch(r.els.contextIndicator, 'keydown', { key: 'Escape' })
  assert.equal(r.stub.inspect(tooltip).classes.includes('presence-closing'), true)
  r.stub.dispatch(tooltip, 'transitionend', { propertyName: 'opacity' })
  assert.equal(r.stub.inspect(tooltip).hidden, true)
})

// --- the attachment control (S11) -------------------------------------------------

import type { AttachmentStripView } from '../src/desktop/renderer/model/composerAttachments.js'

/** A strip the pane would paint: one ready, one importing, one failed. */
function stripView(overrides: Partial<AttachmentStripView> = {}): AttachmentStripView {
  return {
    rows: [
      { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080，动画首帧' },
      { draftId: 'd2', state: 'importing', label: '图片 2：waiting.png', detail: '导入中…' },
      { draftId: 'd3', state: 'failed', label: '图片 3：bad.png', detail: '失败：not decodable' },
    ],
    readyCount: 1,
    ...overrides,
  }
}

test('the + menu offers both entrances and keeps the @ path intact', (t) => {
  const r = render(t)
  r.stub.click(r.els.attach)
  assert.deepEqual(r.attachMenuItems().map((item) => item.text), ['选择图片', '引用项目文件（@）'])

  r.stub.click(r.attachMenuItems()[1]!.node)
  assert.deepEqual(r.attaches, [1], 'the mention path still asks the pane to recompute completions')
  assert.equal(input(r).value, '@')
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.click(r.attachMenuItems()[0]!.node)
  assert.deepEqual(r.pickedImages, [1])
})

test('the + menu closes three ways and never while clicking inside it', (t) => {
  const r = render(t)
  r.stub.click(r.els.attach)

  r.stub.dispatch(r.attachShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.dispatchDocument('pointerdown', { target: r.attachMenuItems()[0]!.node })
  assert.equal(r.attachMenuItems().length, 2, 'a press on an item is not leaving')

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.dispatch(r.attachShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.composer.closeMenus()
  assert.deepEqual(r.attachMenuItems(), [], 'a background pane cannot leave it hanging over the next one')
})

test('the strip draws every state, with remove, retry and open wired per row', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView())
  const rows = r.attachmentRows()
  assert.deepEqual(rows.map((row) => row.classes.includes('attachment-row')), [true, true, true])

  const ready = rows[0]!
  // Ready: [thumbnail, label, remove] — the thumbnail (S12) previews, the label
  // opens the original; no retry affordance.
  assert.equal(ready.children[0]?.classes.includes('attachment-thumb'), true)
  assert.equal(ready.children[1]?.text, '图片 1：shot.png，1920×1080，动画首帧')
  assert.equal(ready.children[2]?.classes.includes('attachment-remove'), true)
  r.stub.click(ready.children[1]!.node)
  assert.deepEqual(r.openedDrafts, ['d1'])

  const failed = rows[2]!
  assert.equal(failed.children[0]?.text, '图片 3：bad.png（失败：not decodable）')
  r.stub.click(failed.children[0]!.node)
  assert.deepEqual(r.openedDrafts, ['d1'], 'a failed row is not a link')
  const retry = failed.children.find((child) => child.classes.includes('attachment-retry'))
  assert.ok(retry, 'a failed row offers 重试')
  r.stub.click(failed.children.find((child) => child.classes.includes('attachment-remove'))!.node)
  assert.deepEqual(r.removedDrafts, ['d3'])

  const importing = rows[1]!
  assert.equal(importing.children.find((child) => child.classes.includes('attachment-retry')), undefined)
  r.stub.click(importing.children.find((child) => child.classes.includes('attachment-remove'))!.node)
  assert.deepEqual(r.removedDrafts, ['d3', 'd2'])
})

test('an unchanged strip is not rebuilt; the send note rides the submit button', (t) => {
  const r = render(t)
  const view = stripView({ sendBlockNote: '当前模型不支持图像输入。' })
  r.composer.renderAttachments(view)
  const before = r.attachmentRows().map((row) => row.node)

  for (let tick = 0; tick < 5; tick += 1) r.composer.renderAttachments(view)
  assert.deepEqual(r.attachmentRows().map((row) => row.node), before, 'streaming-rate repaints must not rebuild a row under the pointer')
  assert.match((r.els.submit as { title: string }).title, /当前模型不支持图像输入/)

  // The note leaves with the state that caused it.
  r.composer.renderAttachments(stripView())
  assert.equal((r.els.submit as { title: string }).title, '发送')

  // A changed strip still repaints, or the signature guard would be a freeze.
  const changed = stripView({ rows: stripView().rows.slice(0, 1) })
  r.composer.renderAttachments(changed)
  assert.equal(r.attachmentRows().length, 1)

  // Empty repaints clear the host, and do not paint an empty list.
  r.composer.renderAttachments({ rows: [], readyCount: 0 })
  assert.deepEqual(r.attachmentRows(), [])
})

test('an image paste becomes attachments; a text paste stays the textarea\'s', (t) => {
  const r = render(t)
  const image = { name: 'shot.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) }
  const text = { name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) }

  const imagePaste = r.stub.dispatch(r.els.input, 'paste', {
    clipboardData: { files: [image] },
  })
  assert.equal(imagePaste.defaultPrevented, true, 'an image paste must not also insert text')
  assert.equal(r.pastedFiles.length, 1)
  assert.deepEqual(r.pastedFiles[0]!.map((file) => file.name), ['shot.png'])

  const textPaste = r.stub.dispatch(r.els.input, 'paste', {
    clipboardData: { files: [text] },
  })
  assert.equal(textPaste.defaultPrevented, false)
  assert.equal(r.pastedFiles.length, 1, 'a text paste is none of this view\'s business')

  const emptyPaste = r.stub.dispatch(r.els.input, 'paste', {})
  assert.equal(emptyPaste.defaultPrevented, false)
  assert.equal(r.pastedFiles.length, 1)
})

// --- thumbnails and the preview popover (S12) ------------------------------------

test('a ready row paints a thumbnail whose click previews; the label still opens', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView({ rows: [
    { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080', imageId: 'img-1', thumbUrl: 'data:image/png;base64,AA' },
  ] }))
  const row = r.attachmentRows()[0]!
  const thumb = row.children.find((child) => child.classes.includes('attachment-thumb'))
  assert.ok(thumb, 'a ready row paints a thumbnail')
  assert.equal(thumb.attributes.get('src'), 'data:image/png;base64,AA')
  assert.equal(thumb.attributes.get('alt'), '图片 1：shot.png，1920×1080')

  r.stub.click(thumb.node)
  assert.deepEqual(r.previewedDrafts, ['d1'], 'the thumbnail previews; it does not open the original')
  assert.deepEqual(r.openedDrafts, [])

  r.stub.click(row.children.find((child) => child.classes.includes('attachment-label'))!.node)
  assert.deepEqual(r.openedDrafts, ['d1'], 'the label keeps the S11 open-original behaviour')

  // A ready row without a URL yet paints the thumbnail without a src — the
  // alt text carries the facts until the on-demand load settles.
  r.composer.renderAttachments(stripView())
  const pending = r.attachmentRows()[0]!.children.find((child) => child.classes.includes('attachment-thumb'))
  assert.ok(pending)
  assert.equal(pending.attributes.has('src'), false)
  assert.equal(pending.attributes.get('alt'), '图片 1：shot.png，1920×1080，动画首帧')
})

test('a thumbnail arriving later repaints the row once; an unchanged strip does not', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView())
  const before = r.attachmentRows()[0]!.node
  for (let tick = 0; tick < 5; tick += 1) r.composer.renderAttachments(stripView())
  assert.equal(r.attachmentRows()[0]!.node, before, 'no URL, no rebuild — the frame budget holds')

  r.composer.renderAttachments(stripView({ rows: [
    { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080', imageId: 'img-1', thumbUrl: 'data:image/png;base64,BB' },
  ] }))
  const after = r.attachmentRows()[0]!.node
  assert.notEqual(after, before, 'a gained URL is real content change')
  assert.equal(
    r.attachmentRows()[0]!.children.find((child) => child.classes.includes('attachment-thumb'))?.attributes.get('src'),
    'data:image/png;base64,BB',
  )
})

test('the preview popover closes three ways and keeps its focus rule', (t) => {
  const r = render(t)
  r.composer.showAttachmentPreview({
    draftId: 'd1',
    imageId: 'img-1',
    name: 'shot.png',
    dimensions: '1920×1080，动画首帧',
    dataUrl: 'data:image/png;base64,AA',
  })

  const preview = (): StubView | undefined =>
    r.stub.inspect(r.attachShell).children.find((child) => child.classes.includes('attachment-preview') && child.attributes.get('aria-hidden') !== 'true')
  const panel = preview()
  assert.ok(panel)
  assert.equal(panel.attributes.get('role'), 'dialog')
  assert.equal(panel.attributes.get('aria-label'), '图片预览：shot.png')
  assert.equal(
    panel.children.find((child) => child.classes.includes('attachment-preview-image'))?.attributes.get('src'),
    'data:image/png;base64,AA',
  )
  assert.match(panel.children.find((child) => child.classes.includes('attachment-preview-caption'))?.text ?? '', /1920×1080/)
  // The head's own children carry the name and the close button.
  const head = panel.children.find((child) => child.classes.includes('attachment-preview-head'))
  assert.equal(head?.children.find((child) => child.classes.includes('attachment-preview-name'))?.text, 'shot.png')

  // 打开原图 inside the popover: the S11 action, routed back through the pane.
  const open = panel.children
    .flatMap((child) => [...child.children])
    .find((child) => child.classes.includes('attachment-preview-open'))
  assert.ok(open)
  r.stub.click(open.node)
  assert.deepEqual(r.openedDrafts, ['d1'])
  assert.equal(preview(), undefined, 'choosing the original closes the popover')
  assert.equal(r.stub.activeElement(), r.els.input, 'focus lands back in the composer')

  // A press outside the panel — but inside it is not outside.
  r.composer.showAttachmentPreview({ draftId: 'd1', imageId: 'img-1', name: 'shot.png', dimensions: '1920×1080', dataUrl: 'x' })
  const close = preview()!.children
    .flatMap((child) => [...child.children])
    .find((child) => child.classes.includes('attachment-preview-close'))!
  r.stub.dispatchDocument('pointerdown', { target: close.node })
  assert.ok(preview(), 'a press on the popover\'s own control is not leaving')
  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.equal(preview(), undefined)

  // focusout with a relatedTarget outside closes; null is this view's repaint.
  r.composer.showAttachmentPreview({ draftId: 'd1', imageId: 'img-1', name: 'shot.png', dimensions: '1920×1080', dataUrl: 'x' })
  const node = r.els.input.parentElement // any node is fine: dispatch goes on the panel host below
  void node
  r.stub.dispatch(r.attachShell, 'focusout', { relatedTarget: null })
  assert.ok(preview(), 'a null relatedTarget is the view\'s own repaint, not the user leaving')

  // Escape: consumed on the panel, and closes it.
  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  r.composer.showAttachmentPreview({ draftId: 'd1', imageId: 'img-1', name: 'shot.png', dimensions: '1920×1080', dataUrl: 'x' })
  r.stub.dispatch(preview()!.node, 'keydown', { key: 'Escape' })
  assert.equal(preview(), undefined)

  // closeMenus takes it too — a background pane cannot leave it hanging.
  r.composer.showAttachmentPreview({ draftId: 'd1', imageId: 'img-1', name: 'shot.png', dimensions: '1920×1080', dataUrl: 'x' })
  r.composer.closeMenus()
  assert.equal(preview(), undefined)
})
