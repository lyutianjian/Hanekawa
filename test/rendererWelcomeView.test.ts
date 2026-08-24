import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createWelcomeView } from '../src/desktop/renderer/dom/welcomeView.js'
import type { WelcomeView } from '../src/desktop/renderer/model/welcome.js'

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
function welcomeViewFixture(overrides: Partial<WelcomeView> = {}): WelcomeView {
  return {
    visible: true,
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
  const dom = createWelcomeView(container, () => switched.push('x'), () => focused.push('x'))
  dom.render(initial)
  return {
    stub,
    container,
    switched,
    focused,
    view: () => stub.inspect(container),
    rerender: (next = initial) => dom.render(next),
  }
}

const child = (view: StubView, className: string): StubView => {
  const found = view.children.find((node) => node.classes.includes(className))
  assert.ok(found, `no .${className} in ${view.children.map((c) => c.className).join(' | ')}`)
  return found
}

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
  const sources = ['dom.ts', 'controls.ts', 'icons.ts'].map((name) =>
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
