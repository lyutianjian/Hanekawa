import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createWelcomeView } from '../src/desktop/renderer/dom/welcomeView.js'
import type { WelcomeView } from '../src/desktop/renderer/model/welcome.js'
import {
  branchPickerView,
  createBranchPickerState,
  type BranchPickerIntent,
  type BranchPickerState,
} from '../src/desktop/renderer/model/branchPicker.js'
import {
  createProjectPickerState,
  projectPickerView,
  type ProjectPickerIntent,
  type ProjectPickerState,
} from '../src/desktop/renderer/model/projectPicker.js'

/**
 * The renderer's first `dom/` unit test.
 *
 * Until this file, `dom/` and `paneSession.ts` were covered only by
 * `scripts/smoke-desktop.mjs` — a real Electron run needing a display and
 * credentials — which is why both bugs stage 4f fixed lived here. `test/helpers/domStub.ts`
 * is the smallest thing that makes a view renderable in `node --test`.
 *
 * This file is **not** in the base TypeScript program: the base `lib` is `ES2022`
 * only, and that absence is what stops host code from touching `document`. It is
 * excluded there and checked by `tsconfig.domtest.json` instead;
 * `test/rendererImports.test.ts` asserts those two lists agree.
 *
 * The stub is installed per test and removed in `t.after`. Contamination is
 * bounded anyway — `node --test` runs one process per file, and `dom.ts`,
 * `controls.ts` and `icons.ts` all read `document` inside function bodies rather
 * than capturing it at import time.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')

// A static import is safe — and is itself part of the claim in the header: none of
// the three helpers reads `document` at module scope, so importing the view before
// the stub is installed cannot capture a missing global.
const PICKER_STATE: BranchPickerState = createBranchPickerState({
  branches: ['master', 'topic', 'release'],
  current: 'master',
})

function pickerFixture(overrides: Partial<BranchPickerState> = {}) {
  return branchPickerView({ ...PICKER_STATE, ...overrides })
}

const PROJECT_STATE: ProjectPickerState = createProjectPickerState({
  projects: [
    { root: '/repos/hanekawa', name: 'Hanekawa-main' },
    { root: '/repos/side', name: 'side' },
  ],
  current: '/repos/hanekawa',
})

function projectFixture(overrides: Partial<ProjectPickerState> = {}) {
  return projectPickerView({ ...PROJECT_STATE, ...overrides })
}

function welcomeViewFixture(overrides: Partial<WelcomeView> = {}): WelcomeView {
  return {
    branchPicker: pickerFixture(),
    projectPicker: projectFixture(),
    visible: true,
    global: false,
    titleBefore: '你想让我们在 ',
    projectLabel: 'Hanekawa-main',
    titleAfter: ' 中构建什么？',
    wordmark: 'hanekawa',
    hints: [
      { keys: ['/'], label: '命令' },
      { keys: ['@'], label: '引用文件' },
      { keys: ['Shift', 'Tab'], label: '切换权限模式' },
    ],
    pills: [
      { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: false },
      { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
    ],
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: BranchPickerIntent[]
  /** The project switcher's own intents, kept apart so neither list can hide the other. */
  readonly projectIntents: ProjectPickerIntent[]
  view(): StubView
  rerender(next?: WelcomeView): void
}

function render(
  t: { after(fn: () => void): void },
  initial = welcomeViewFixture(),
): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('welcome')
  const intents: BranchPickerIntent[] = []
  const projectIntents: ProjectPickerIntent[] = []
  const dom = createWelcomeView(container, {
    onBranchIntent: (intent) => intents.push(intent),
    onBranchKey: () => false,
    onProjectIntent: (intent) => projectIntents.push(intent),
    onProjectKey: () => false,
  })
  dom.render(initial)
  return {
    stub,
    container,
    intents,
    projectIntents,
    view: () => stub.inspect(container),
    rerender: (next = initial) => dom.render(next),
  }
}

/**
 * The first descendant carrying a class, in document order.
 *
 * Descendants rather than direct children since the Hero gained its own row and
 * the branch pill its own anchor: a test that asserts the *nesting* rather than
 * the content would fail every time that scaffolding moves.
 */
const find = (view: StubView, className: string): StubView | undefined => {
  for (const node of view.children) {
    if (node.classes.includes(className)) return node
    const nested = find(node, className)
    if (nested) return nested
  }
  return undefined
}

const child = (view: StubView, className: string): StubView => {
  const found = find(view, className)
  assert.ok(found, `no .${className} in ${view.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every `<button>` in the subtree — what "no focusable node" is asserted on. */
const buttons = (view: StubView): StubView[] =>
  view.children.flatMap((node) => (node.tagName === 'BUTTON' ? [node] : buttons(node)))

test('the empty state draws a wordmark, a hero, the pills and the hint row', (t) => {
  const { view } = render(t)
  const root = view()

  assert.equal(root.hidden, false)
  // No graphic mark — that is the design. An icon over three centred cards is
  // the shape every agent shell ships, so it identifies none of them.
  assert.equal(find(root, 'welcome-mark'), undefined)
  assert.equal(find(root, 'welcome-cards'), undefined)
  assert.equal(child(root, 'welcome-wordmark').text, 'hanekawa')

  const title = child(root, 'welcome-title')
  assert.equal(title.tagName, 'H1')
  // Text, the project name, text — the reason the model splits the sentence into
  // three fields instead of interpolating one string.
  assert.equal(title.nodes.length, 3)
  assert.equal(title.nodes[0], '你想让我们在 ')
  assert.equal(title.nodes[2], ' 中构建什么？')
  const project = title.nodes[1]
  assert.ok(typeof project !== 'string')
  // A span, not a button: the workspace switcher it used to open is gone, and a
  // control that does nothing is a worse lie than plain text.
  assert.equal(project.tagName, 'SPAN')
  assert.ok(project.classes.includes('welcome-project-name'))
  assert.equal(project.text, 'Hanekawa-main')

  const hints = child(root, 'welcome-hints').children
  assert.equal(hints.length, 3)
  assert.deepEqual(hints.map((hint) => hint.tagName), ['SPAN', 'SPAN', 'SPAN'])
  assert.deepEqual(hints.map((hint) => hint.text), ['/命令', '@引用文件', 'ShiftTab切换权限模式'])
  // The keys are their own nodes so the sheet can set them in the mono stack
  // without the view parsing a sentence apart.
  assert.deepEqual(
    hints.map((hint) => hint.children.filter((n) => n.tagName === 'KBD').map((n) => n.text)),
    [['/'], ['@'], ['Shift', 'Tab']],
  )
})

test('the global workspace hero is one text node with no project segment', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      global: true,
      titleBefore: '你想让我们构建什么？',
      titleAfter: '',
      projectLabel: '',
      pills: [{ kind: 'project', label: '~/.myagent', icon: 'folder', interactive: false }],
    }),
  )

  const title = child(view(), 'welcome-title')
  assert.equal(title.nodes.length, 1)
  assert.equal(title.nodes[0], '你想让我们构建什么？')
  assert.equal(find(view(), 'welcome-project-name'), undefined)
})

test('a pill the model calls read-only is a span, and the branch pill is a control', (t) => {
  const { view, stub, intents } = render(t)
  const pills = child(view(), 'welcome-pills').children

  // Two pills — the 「本地」one that used to sit between them named the one
  // runtime that has ever existed. The project pill is read-only in this
  // fixture, so it is a span; the switchable case is the test below.
  assert.equal(pills.length, 2)
  assert.equal(child(view(), 'welcome-project-slot').children[0]?.tagName, 'SPAN')
  assert.equal(pills[0]?.text, 'Hanekawa-main')

  const branch = child(view(), 'welcome-branch-slot')
  const trigger = branch.children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'BUTTON')
  assert.equal(trigger.text, 'master')

  // The popover's own panel is not a Tab stop, so it is not a button either.
  assert.deepEqual(buttons(view()).map((node) => node.text), ['master'])

  stub.click(trigger.node)
  assert.deepEqual(intents, [{ kind: 'open' }])
})

test('a branch that cannot be switched is a plain span again', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      pills: [
        { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: false },
        { kind: 'branch', label: 'master', icon: 'branch', interactive: false },
      ],
    }),
  )
  const trigger = child(view(), 'welcome-branch-slot').children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'SPAN')
})

test('a switchable project pill opens its own popover and lists the added projects', (t) => {
  const { view, stub, intents, projectIntents } = render(
    t,
    welcomeViewFixture({
      pills: [
        { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: true },
        { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
      ],
      projectPicker: projectFixture({ open: true }),
    }),
  )

  const trigger = child(view(), 'welcome-project-slot').children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'BUTTON')
  stub.click(trigger.node)
  // Each pill opens *its* switcher: the two triggers sit side by side, so a
  // shared handler would be a project click asking for the branch list.
  assert.deepEqual(projectIntents, [{ kind: 'open' }])
  assert.deepEqual(intents, [])

  const rows = child(view(), 'project-picker-body').children
  assert.deepEqual(rows.map((row) => row.text), ['Hanekawa-main', 'side'])
  assert.deepEqual(rows.map((row) => row.classes.includes('current')), [true, false])

  stub.click(rows[1]!.node)
  stub.click(rows[0]!.node)
  assert.deepEqual(projectIntents.slice(1), [
    { kind: 'pick', root: '/repos/side' },
    // The project this pane is already in is not a destination.
    { kind: 'close' },
  ])
})

test('the two popovers are separate anchors: a press in one does not close the other', (t) => {
  const { view, stub, intents, projectIntents } = render(
    t,
    welcomeViewFixture({
      pills: [
        { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: true },
        { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
      ],
      projectPicker: projectFixture({ open: true }),
    }),
  )

  // A press inside the project anchor is outside the branch one, so the branch
  // picker hears a close and the project picker does not.
  stub.dispatchDocument('pointerdown', { target: child(view(), 'project-picker-row').node })
  assert.deepEqual(projectIntents, [])
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('an invisible screen is hidden and holds no focusable node', (t) => {
  const { view } = render(t, welcomeViewFixture({ visible: false }))
  const root = view()

  assert.equal(root.hidden, true)
  // Dropped, not merely hidden: a leftover button is still a Tab stop out of the
  // composer.
  assert.equal(root.children.length, 0)
})

test('a screen that goes invisible keeps its scaffolding and drops every button', (t) => {
  const { view, rerender } = render(t)
  assert.ok(buttons(view()).length > 0)

  rerender(welcomeViewFixture({ visible: false }))
  const root = view()

  assert.equal(root.hidden, true)
  assert.ok(root.children.length > 0, 'the scaffolding survives')
  assert.deepEqual(buttons(root), [])
})

test('a closed popover is hidden and lists nothing', (t) => {
  const { view } = render(t)
  const picker = child(view(), 'branch-picker')

  assert.equal(picker.hidden, true)
  assert.equal(find(picker, 'branch-picker-row'), undefined)
})

test('an open popover lists the branches and ticks the current one', (t) => {
  const { view } = render(t, welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }))
  const picker = child(view(), 'branch-picker')

  assert.equal(picker.hidden, false)
  const rows = child(picker, 'branch-picker-body').children.filter((node) =>
    node.classes.includes('branch-picker-row'),
  )
  assert.deepEqual(rows.map((row) => row.text), ['master', 'topic', 'release'])
  assert.deepEqual(rows.map((row) => row.classes.includes('current')), [true, false, false])
})

test('a loading popover says so instead of drawing an empty list', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true, loading: true, branches: [] }) }),
  )
  const picker = child(view(), 'branch-picker')

  assert.equal(child(picker, 'branch-picker-empty').text, '正在读取分支…')
  assert.equal(find(picker, 'branch-picker-row'), undefined)
})

test("git's refusal is drawn under the rows the user was choosing from", (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      branchPicker: pickerFixture({ open: true, error: 'error: Your local changes…' }),
    }),
  )
  const picker = child(view(), 'branch-picker')

  assert.equal(child(picker, 'branch-picker-error').text, 'error: Your local changes…')
  // The list stays: a popover that replaced its rows with the error would leave
  // the user nothing to retry with.
  assert.ok(find(picker, 'branch-picker-row'))
})

test('choosing a branch asks to switch; choosing the current one only closes', (t) => {
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )
  const rows = child(view(), 'branch-picker-body').children

  stub.click(rows[1]!.node)
  stub.click(rows[0]!.node)

  assert.deepEqual(intents, [{ kind: 'pick', branch: 'topic' }, { kind: 'close' }])
})

test('rows stop responding while a switch is in flight', (t) => {
  // `git switch` moves the working tree; a second one queued behind the first
  // would run against a tree the user never saw.
  const { view } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true, switching: true }) }),
  )
  const rows = child(view(), 'branch-picker-body').children
  assert.deepEqual(rows.map((row) => row.disabled), [true, true, true])
})

test('a press outside the branch anchor closes the popover; inside it does not', (t) => {
  // The popover hangs over the transcript, and the transcript is unfocusable
  // scenery: without this it could only be closed with Escape or by picking.
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )

  stub.dispatchDocument('pointerdown', { target: child(view(), 'branch-picker-row').node })
  assert.deepEqual(intents, [], 'a press on a row is the user choosing from it')

  // The pill is what opens this and sits *inside* the anchor beside the popover:
  // a press there must reach its own toggle, or the click that follows would
  // re-open what the user just shut.
  stub.dispatchDocument('pointerdown', { target: child(view(), 'welcome-branch-slot').children[0]!.node })
  assert.deepEqual(intents, [])

  stub.dispatchDocument('pointerdown', { target: stub.createContainer('transcript-area') })
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('focus leaving the popover closes it, but a repaint does not', (t) => {
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )
  const anchor = child(view(), 'welcome-branch-anchor')

  // `relatedTarget === null` is this view's own repaint, not the user leaving —
  // answering it with a close would shut the popover on the paint that drew it.
  stub.dispatch(anchor.node, 'focusout', { relatedTarget: null })
  assert.deepEqual(intents, [])

  // Inside the anchor is still inside the popover: moving from a row to the pill
  // is not leaving.
  stub.dispatch(anchor.node, 'focusout', { relatedTarget: child(view(), 'branch-picker-row').node })
  assert.deepEqual(intents, [])

  stub.dispatch(anchor.node, 'focusout', { relatedTarget: stub.createContainer('composer') })
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('the branch pill keeps its popover across an open and a close', (t) => {
  const { view, rerender, stub } = render(t)
  const before = child(view(), 'branch-picker').node

  rerender(welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }))
  const during = child(view(), 'branch-picker').node
  rerender()
  const after = child(view(), 'branch-picker').node

  // Identity: the panel is the node that takes focus when the popover opens, so
  // rebuilding it would blur itself and fire the `focusout` that closes it.
  assert.equal(during, before)
  assert.equal(after, before)
  assert.equal(stub.inspect(after).classes.includes('presence-closing'), true)
  assert.equal(stub.inspect(after).attributes.has('inert'), true)
  assert.ok(find(stub.inspect(after), 'branch-picker-row'), 'rows remain through exit')
  stub.dispatch(after, 'transitionend', { propertyName: 'opacity' })
  assert.equal(stub.inspect(after).hidden, true)
  assert.equal(find(stub.inspect(after), 'branch-picker-row'), undefined)
})

test('rendering the same view twice rebuilds nothing', (t) => {
  const { view, rerender } = render(t)
  const before = child(view(), 'welcome-hints').children.map((hint) => hint.node)
  rerender()
  const after = child(view(), 'welcome-hints').children.map((hint) => hint.node)

  // Identity, not equality: this view repaints once per streamed token, so the
  // signature guard is load-bearing rather than tidiness.
  assert.deepEqual(after, before)
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const { stub } = render(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'branchPickerView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  // Non-vacuity first: a regex that matched nothing would make this test a
  // decoration rather than the thing that keeps the fake honest.
  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})
