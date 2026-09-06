import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createWelcomeView } from '../src/desktop/renderer/dom/welcomeView.js'
import type { WelcomeView } from '../src/desktop/renderer/model/welcome.js'
import {
  workspacePickerView,
  type WorkspacePickerIntent,
  type WorkspacePickerState,
} from '../src/desktop/renderer/model/workspacePicker.js'

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
const PICKER_STATE: WorkspacePickerState = {
  open: false,
  query: '',
  options: [
    { projectRoot: '/w/hanekawa', projectName: 'Hanekawa-main', isGlobal: false },
    { projectRoot: '/w/win6', projectName: 'win6', isGlobal: false },
    { projectRoot: '/home/miyano', projectName: '最近', isGlobal: true },
  ],
  currentRoot: '/w/hanekawa',
  globalRoot: '/home/miyano',
  selectedIndex: -1,
}

function pickerFixture(overrides: Partial<WorkspacePickerState> = {}) {
  return workspacePickerView({ ...PICKER_STATE, ...overrides })
}

function welcomeViewFixture(overrides: Partial<WelcomeView> = {}): WelcomeView {
  return {
    picker: pickerFixture(),
    visible: true,
    global: false,
    titleBefore: '你想让我们在 ',
    projectLabel: 'Hanekawa-main',
    titleAfter: ' 中构建什么？',
    projectSwitchable: true,
    cards: [
      { kind: 'explore', title: '探索并理解代码', icon: 'megaphone' },
      { kind: 'build', title: '构建新功能、应用或工具', icon: 'hammer' },
      { kind: 'review', title: '审查代码并提出修改建议', icon: 'refresh' },
    ],
    pills: [
      { kind: 'project', label: 'Hanekawa-main', icon: 'folder' },
      { kind: 'local', label: '本地', icon: 'monitor' },
      { kind: 'branch', label: 'master', icon: 'branch' },
    ],
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly switched: string[]
  readonly focused: string[]
  readonly intents: WorkspacePickerIntent[]
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
  const switched: string[] = []
  const focused: string[] = []
  const intents: WorkspacePickerIntent[] = []
  const dom = createWelcomeView(container, {
    onSwitchWorkspace: () => switched.push('x'),
    onFocusComposer: () => focused.push('x'),
    onPickerIntent: (intent) => intents.push(intent),
    onPickerKey: () => false,
  })
  dom.render(initial)
  return {
    stub,
    container,
    switched,
    focused,
    intents,
    view: () => stub.inspect(container),
    rerender: (next = initial) => dom.render(next),
  }
}

/**
 * The first descendant carrying a class, in document order.
 *
 * Descendants rather than direct children since the Hero gained its own row: the
 * title is nested a level down so the picker has something to be positioned
 * against, and a test that asserts the *nesting* rather than the content would
 * fail every time that scaffolding moves.
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

test('the empty state draws a mark, a hero, three cards and the pills', (t) => {
  const { view } = render(t)
  const root = view()

  assert.equal(root.hidden, false)
  assert.equal(child(root, 'welcome-mark').children.length, 1)
  assert.equal(child(root, 'welcome-mark').children[0]?.tagName, 'svg')

  const title = child(root, 'welcome-title')
  assert.equal(title.tagName, 'H1')
  // Text, the project control, text — the reason the model splits the sentence
  // into three fields instead of interpolating one string.
  assert.equal(title.nodes.length, 3)
  assert.equal(title.nodes[0], '你想让我们在 ')
  assert.equal(title.nodes[2], ' 中构建什么？')
  const project = title.nodes[1]
  assert.ok(typeof project !== 'string')
  assert.equal(project.tagName, 'BUTTON')
  assert.ok(project.classes.includes('welcome-project'))
  assert.equal(project.text, 'Hanekawa-main')

  const cards = child(root, 'welcome-cards').children
  assert.equal(cards.length, 3)
  assert.deepEqual(cards.map((card) => card.tagName), ['BUTTON', 'BUTTON', 'BUTTON'])
  assert.deepEqual(
    cards.map((card) => card.classes.filter((name) => name !== 'welcome-card')),
    [['explore'], ['build'], ['review']],
  )
  assert.deepEqual(cards.map((card) => card.text), [
    '探索并理解代码',
    '构建新功能、应用或工具',
    '审查代码并提出修改建议',
  ])
})

test('the global workspace hero is one text node with no project control', (t) => {
  // Nothing is loaded: no project to name, so no button in the middle of the
  // sentence — and nothing left for Tab to walk into.
  const { view } = render(
    t,
    welcomeViewFixture({
      global: true,
      titleBefore: '你想让我们构建什么？',
      titleAfter: '',
      projectLabel: '',
      projectSwitchable: false,
      pills: [
        { kind: 'project', label: '~/.myagent', icon: 'folder' },
        { kind: 'local', label: '本地', icon: 'monitor' },
      ],
    }),
  )

  const title = child(view(), 'welcome-title')
  assert.equal(title.nodes.length, 1)
  assert.equal(title.nodes[0], '你想让我们构建什么？')
  assert.equal(find(view(), 'welcome-project'), undefined, 'the global hero has no project button')
})

test('the context pills are spans, because they are read-only', (t) => {
  const { view } = render(t)
  const pills = child(view(), 'welcome-pills').children

  assert.equal(pills.length, 3)
  // The decision「均只读」, made executable: a button that does nothing when
  // clicked is a worse lie than plain text.
  assert.deepEqual(pills.map((pill) => pill.tagName), ['SPAN', 'SPAN', 'SPAN'])
  assert.deepEqual(pills.map((pill) => pill.text), ['Hanekawa-main', '本地', 'master'])
})

test('a card click only focuses the composer', (t) => {
  const { view, stub, switched, focused } = render(t)
  for (const card of child(view(), 'welcome-cards').children) stub.click(card.node)

  assert.equal(focused.length, 3)
  assert.equal(switched.length, 0, 'the cards are guidance, not navigation')
})

test('the hero project name asks the shell to switch workspaces', (t) => {
  const { view, stub, switched, focused } = render(t)
  const project = child(view(), 'welcome-title').nodes[1]
  assert.ok(typeof project !== 'string')
  stub.click(project.node)

  assert.deepEqual([switched.length, focused.length], [1, 0])
})

test('an unswitchable project name is a disabled control', (t) => {
  const { view } = render(t, welcomeViewFixture({ projectSwitchable: false }))
  const project = child(view(), 'welcome-title').nodes[1]
  assert.ok(typeof project !== 'string')
  assert.equal(project.disabled, true)
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
  // The shells stay — the picker's search input is the one node here that holds
  // a caret, and rebuilding it is what would drop focus mid-keystroke — but
  // nothing focusable may be left behind.
  assert.ok(root.children.length > 0, 'the scaffolding survives')
  assert.deepEqual(buttons(root), [])
})

test('a closed picker is hidden and lists nothing', (t) => {
  const { view } = render(t)
  const picker = child(view(), 'workspace-picker')

  assert.equal(picker.hidden, true)
  assert.equal(find(picker, 'workspace-picker-row'), undefined)
})

test('an open picker lists the projects, ticks the current one and offers both actions', (t) => {
  const { view } = render(t, welcomeViewFixture({ picker: pickerFixture({ open: true }) }))
  const picker = child(view(), 'workspace-picker')

  assert.equal(picker.hidden, false)
  const rows = child(picker, 'workspace-picker-body').children.filter((node) =>
    node.classes.includes('workspace-picker-row'),
  )
  // The global workspace is not a row — it is the「不在项目中工作」action below.
  assert.deepEqual(rows.map((row) => row.text), ['Hanekawa-main', 'win6'])
  assert.deepEqual(rows.map((row) => row.classes.includes('current')), [true, false])

  const actions = child(picker, 'workspace-picker-actions').children
  assert.deepEqual(actions.map((action) => action.text), ['新建项目', '不在项目中工作'])
})

test('the picker in the global workspace offers no way to leave it', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      picker: pickerFixture({ open: true, currentRoot: '/home/miyano' }),
    }),
  )
  const actions = child(child(view(), 'workspace-picker'), 'workspace-picker-actions').children

  assert.deepEqual(actions.map((action) => action.text), ['新建项目'])
})

test('picking another project asks to open a session there; the current one only reveals', (t) => {
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ picker: pickerFixture({ open: true }) }),
  )
  const rows = child(child(view(), 'workspace-picker'), 'workspace-picker-body').children

  stub.click(rows[1]!.node)
  stub.click(rows[0]!.node)

  assert.deepEqual(intents, [
    { kind: 'pick', projectRoot: '/w/win6' },
    { kind: 'reveal', projectRoot: '/w/hanekawa' },
  ])
})

test('a press outside the Hero row closes the picker; inside it does not', (t) => {
  // The popover hangs over the transcript, and the transcript is unfocusable
  // scenery: before this it could only be closed with Escape or by picking.
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ picker: pickerFixture({ open: true }) }),
  )

  stub.dispatchDocument('pointerdown', { target: child(view(), 'workspace-picker-row').node })
  assert.deepEqual(intents, [], 'a press on a row is the user choosing from it')

  // The Hero's project name is what opens this, and it sits *beside* the picker
  // in the same row: a press there must reach its own toggle, or the click that
  // follows would re-open what the user just shut.
  stub.dispatchDocument('pointerdown', { target: child(view(), 'welcome-project').node })
  assert.deepEqual(intents, [])

  stub.dispatchDocument('pointerdown', { target: stub.createContainer('transcript-area') })
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('the picker keeps its search box across an open and a close', (t) => {
  const { view, rerender } = render(t)
  const before = child(view(), 'workspace-picker-search').node

  rerender(welcomeViewFixture({ picker: pickerFixture({ open: true, query: 'w' }) }))
  const during = child(view(), 'workspace-picker-search').node
  rerender()
  const after = child(view(), 'workspace-picker-search').node

  // Identity: the input is the one node here that holds a caret, so rebuilding
  // it would drop focus on every keystroke.
  assert.equal(during, before)
  assert.equal(after, before)
})

test('rendering the same view twice rebuilds nothing', (t) => {
  const { view, rerender } = render(t)
  const before = child(view(), 'welcome-cards').children.map((card) => card.node)
  rerender()
  const after = child(view(), 'welcome-cards').children.map((card) => card.node)

  // Identity, not equality: this view repaints once per streamed token, so the
  // signature guard is load-bearing rather than tidiness.
  assert.deepEqual(after, before)
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const { stub } = render(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'workspacePickerView.ts'].map((name) =>
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
