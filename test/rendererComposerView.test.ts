import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createComposerView, type ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import { PERMISSION_MODE_LABELS } from '../src/desktop/renderer/model/composer.js'
import type { PermissionMode } from '../src/harness/permissions.js'
import type { WireRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

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
    'input' | 'submit' | 'stop' | 'attach' | 'chipModel' | 'chipEffort' | 'chipPermission' | 'permissionShell' | 'progress',
    HTMLElement
  >
  readonly picked: PermissionMode[]
  readonly attaches: number[]
  view(name: keyof Rendered['els']): StubView
  /** The menu's items, or an empty list when it is closed. */
  menuItems(): StubView[]
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
    chipModel: stub.createContainer(),
    chipEffort: stub.createContainer(),
    chipPermission: stub.createContainer(),
    permissionShell: stub.createContainer(),
    progress: stub.createContainer(),
  }
  els.permissionShell.appendChild(els.chipPermission)

  const picked: PermissionMode[] = []
  const attaches: number[] = []
  const composer = createComposerView(
    {
      input: els.input as HTMLTextAreaElement,
      submit: els.submit as HTMLButtonElement,
      stop: els.stop as HTMLButtonElement,
      attach: els.attach as HTMLButtonElement,
      chipModel: els.chipModel as HTMLButtonElement,
      chipEffort: els.chipEffort as HTMLButtonElement,
      chipPermission: els.chipPermission as HTMLButtonElement,
      permissionShell: els.permissionShell,
      progress: els.progress,
    },
    {
      onOpenModelPicker: () => {},
      onOpenEffortPicker: () => {},
      onSelectPermissionMode: (mode) => picked.push(mode),
      onAttach: () => attaches.push(1),
    },
  )

  const menu = (): StubView | undefined =>
    stub.inspect(els.permissionShell).children.find((child) => child.classes.includes('composer-menu'))

  return {
    stub,
    composer,
    els,
    picked,
    attaches,
    view: (name) => stub.inspect(els[name]),
    menuItems: () => [...(menu()?.children ?? [])],
  }
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
