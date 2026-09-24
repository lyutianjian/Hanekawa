import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import type {
  ConditionOptions,
  ConditionResult,
  ElementScanOptions,
  ElementScanResult,
  GuardOptions,
  ScrollOptions,
  ScrollResult,
  TargetOptions,
  TargetResult,
  TextScanOptions,
  TextScanResult,
} from '../src/desktop/browser/inject/bundle.js'
import {
  conditionScript,
  elementsScript,
  guardScript,
  resolveScript,
  scrollScript,
  textScript,
  unwrap,
} from '../src/desktop/browser/inject/bundle.js'
import { BrowserHostError } from '../src/desktop/browser/errors.js'
import {
  FIELD_MAX_NAME,
  FIELD_MAX_TEXT,
  INTERACTIVE_SELECTOR,
  SCAN_BUDGET_MS,
  SCAN_MAX_NODES,
  SENSITIVE_AUTOCOMPLETE,
} from '../src/desktop/browser/limits.js'

/**
 * The collectors, actually executed.
 *
 * They are the one part of this subsystem that cannot be checked by reading:
 * they reach the page as *text*, so a helper the bundler forgot to ship is a
 * `ReferenceError` on a real site and nothing at all at compile time. Running
 * the built script in `node:vm` against a hand-made DOM catches that, and while
 * we are in there it also pins the behaviours that matter — refs, the shadow
 * walk, sensitive fields, and every budget.
 *
 * The stub below is deliberately shallow. It implements exactly the methods
 * `inject/dom.ts` declares, which is the same discipline from the other side: if
 * a collector ever reaches for something new, this file fails until the
 * interface and the stub both admit it.
 */

interface StubStyle {
  display: string
  visibility: string
  opacity: string
  cursor: string
}

class TextNode {
  readonly nodeType = 3
  parentElement: StubElement | null = null
  root: { host?: StubElement } = {}
  constructor(readonly textContent: string) {}
  getRootNode(): { host?: StubElement } {
    return this.parentElement === null ? this.root : this.parentElement.getRootNode()
  }
}

interface ElementSpec {
  attrs?: Record<string, string>
  props?: Record<string, unknown>
  text?: string
  children?: StubElement[]
  /** Mixed content in document order, for when text and elements interleave. */
  nodes?: Array<string | StubElement>
  shadow?: Array<string | StubElement>
  /** A `<slot>`'s assigned nodes. */
  assigned?: StubElement[]
  style?: Partial<StubStyle>
  size?: { width: number; height: number }
  /** Viewport position of the box. Absent means the top-left corner. */
  at?: { top: number; left: number }
}

/** The tags the stub lays out inline, as a browser's default stylesheet would. */
const INLINE_TAGS = new Set(['a', 'b', 'i', 'em', 'strong', 'span', 'code', 'label', 'small', 'mark', 'slot'])

interface StubShadowRoot {
  children: StubElement[]
  childNodes: Array<StubElement | TextNode>
  activeElement?: StubElement | null
  elementFromPoint?: HitTest
}

class StubElement {
  readonly nodeType = 1
  readonly tagName: string
  readonly attrs: Record<string, string>
  readonly children: StubElement[] = []
  readonly childNodes: Array<StubElement | TextNode> = []
  parentElement: StubElement | null = null
  shadowRoot: StubShadowRoot | null = null
  readonly style: StubStyle
  /** A ref outlives its node, so the resolver checks this before acting. */
  isConnected = true
  /** Not every element takes focus. `page.type` has to notice when it does not. */
  focusable = true
  scrolledIntoView = false
  owner: { activeElement: StubElement | null } | undefined
  private readonly size: { width: number; height: number }
  private readonly at: { top: number; left: number }
  root: { host?: StubElement } = {}
  assignedNodes?: () => StubElement[]
  dispatched: string[] = []

  constructor(tag: string, spec: ElementSpec = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...spec.attrs }
    const display = INLINE_TAGS.has(tag) ? 'inline' : 'block'
    this.style = { display, visibility: 'visible', opacity: '1', cursor: 'auto', ...spec.style }
    this.size = spec.size ?? { width: 100, height: 20 }
    this.at = spec.at ?? { top: 0, left: 0 }
    Object.assign(this, spec.props ?? {})
    const content: Array<string | StubElement> = [
      ...(spec.text !== undefined ? [spec.text] : []),
      ...(spec.children ?? []),
      ...(spec.nodes ?? []),
    ]
    for (const item of content) {
      const node = typeof item === 'string' ? new TextNode(item) : item
      node.parentElement = this
      if (node instanceof StubElement) this.children.push(node)
      this.childNodes.push(node)
    }
    if (spec.shadow !== undefined) {
      const shadowNodes = spec.shadow.map((item) => (typeof item === 'string' ? new TextNode(item) : item))
      for (const node of shadowNodes) node.root = { host: this }
      this.shadowRoot = {
        children: shadowNodes.filter((node): node is StubElement => node instanceof StubElement),
        childNodes: shadowNodes,
      }
    }
    if (spec.assigned !== undefined) {
      const assigned = spec.assigned
      this.assignedNodes = () => assigned
    }
  }

  get id(): string {
    return this.attrs['id'] ?? ''
  }

  get textContent(): string {
    return this.childNodes
      .map((node) => (node instanceof StubElement ? node.textContent : node.textContent))
      .join(' ')
      .trim()
  }

  getRootNode(): { host?: StubElement } {
    return this.parentElement === null ? this.root : this.parentElement.getRootNode()
  }

  dispatchEvent(event: { type: string }): boolean {
    this.dispatched.push(event.type)
    return true
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs
  }

  getBoundingClientRect(): { width: number; height: number; top: number; left: number } {
    return { ...this.size, ...this.at }
  }

  scrollIntoView(): void {
    this.scrolledIntoView = true
  }

  focus(): void {
    if (this.focusable && this.owner !== undefined) this.owner.activeElement = this
  }

  /** Enough CSS to answer the interactive whitelist: `tag`, `[attr]`, `#id`. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => matchesSimple(this, part.trim()))
  }
}

function matchesSimple(el: StubElement, selector: string): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1)
  const parsed = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/.exec(selector)
  if (parsed === null) return false
  if (parsed[1] !== '' && el.tagName.toLowerCase() !== parsed[1]) return false
  for (const attr of (parsed[2] ?? '').match(/\[[^\]]+\]/g) ?? []) {
    if (!el.hasAttribute(attr.slice(1, -1))) return false
  }
  return true
}

function el(tag: string, spec: ElementSpec = {}): StubElement {
  return new StubElement(tag, spec)
}

function walk(root: StubElement, visit: (el: StubElement) => boolean): StubElement | null {
  const stack: StubElement[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as StubElement
    if (visit(node)) return node
    stack.push(...(node.shadowRoot?.children ?? []), ...node.children)
  }
  return null
}

/** Says who is on top at a viewport point. The stub has no layout to work it out. */
type HitTest = (x: number, y: number) => StubElement | null

function documentFor(
  body: StubElement,
  activeElement: StubElement | null = null,
  hit: HitTest = () => null,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    body,
    documentElement: body,
    title: 'Stub Page',
    URL: 'https://stub.test/page',
    activeElement,
    querySelector: (selector: string) => walk(body, (node) => matchesSimple(node, selector)),
    getElementById: (id: string) => walk(body, (node) => node.id === id),
    elementFromPoint: hit,
  }
  // `focus()` has to move the document's own idea of what is focused, which is
  // the only thing the resolver trusts as proof that focusing worked.
  walk(body, (node) => {
    node.owner = doc as unknown as { activeElement: StubElement | null }
    return false
  })
  return doc
}

/** A fresh window per run: the scroll functions mutate its position. */
function windowFor(): {
  getComputedStyle: (node: StubElement) => StubStyle
  innerWidth: number
  innerHeight: number
  scrollX: number
  scrollY: number
  scrollBy: (x: number, y: number) => void
  scrollTo: (x: number, y: number) => void
} {
  const win = {
    getComputedStyle: (node: StubElement) => node.style,
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    scrollBy: (_x: number, y: number) => {
      win.scrollY = Math.max(0, win.scrollY + y)
    },
    scrollTo: (_x: number, y: number) => {
      win.scrollY = Math.max(0, y)
    },
  }
  return win
}

function elementOptions(overrides: Partial<ElementScanOptions> = {}): ElementScanOptions {
  return {
    snapshotId: 'snapshot-1',
    interactiveOnly: true,
    visibleOnly: true,
    maxResults: 50,
    maxNodes: SCAN_MAX_NODES,
    budgetMs: SCAN_BUDGET_MS,
    nameMax: FIELD_MAX_NAME,
    textMax: FIELD_MAX_TEXT,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    interactiveSelector: INTERACTIVE_SELECTOR,
    ...overrides,
  }
}

function runElements(
  body: StubElement,
  overrides: Partial<ElementScanOptions> = {},
  activeElement: StubElement | null = null,
): { result: ElementScanResult; sandbox: Record<string, unknown> } {
  const sandbox: Record<string, unknown> = { document: documentFor(body, activeElement), window: windowFor() }
  const raw = vm.runInNewContext(elementsScript(elementOptions(overrides)), sandbox)
  return { result: unwrap<ElementScanResult>(serialize(raw)), sandbox }
}

function runText(body: StubElement, overrides: Partial<TextScanOptions> = {}): TextScanResult {
  const options: TextScanOptions = {
    visibleOnly: true,
    maxResults: 200,
    maxNodes: SCAN_MAX_NODES,
    budgetMs: SCAN_BUDGET_MS,
    segmentMax: FIELD_MAX_TEXT,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    ...overrides,
  }
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }
  return unwrap<TextScanResult>(serialize(vm.runInNewContext(textScript(options), sandbox)))
}

/**
 * The trip a real result takes on its way out of the renderer.
 *
 * Electron structured-clones the value of an isolated-world evaluation, so the
 * object the host sees is a plain one from its own realm. Doing the same here is
 * not a test convenience: it is what makes the assertions below compare the same
 * thing production does, including the `undefined` keys that never survive.
 */
function serialize(raw: unknown): unknown {
  return JSON.parse(JSON.stringify(raw))
}

test('the built script runs with nothing but a DOM, and hands back refs', () => {
  const body = el('body', {
    children: [
      el('a', { attrs: { href: '/home' }, props: { href: 'https://stub.test/home' }, text: 'Home' }),
      el('button', { text: 'Save' }),
      el('p', { text: 'Not interactive' }),
    ],
  })
  const { result, sandbox } = runElements(body)

  assert.deepEqual(
    result.rows.map((row) => [row.ref, row.role, row.name]),
    [
      ['e1', 'link', 'Home'],
      ['e2', 'button', 'Save'],
    ],
  )
  assert.equal(result.rows[0]?.href, 'https://stub.test/home')
  assert.equal(result.truncated, false)
  assert.equal(result.url, 'https://stub.test/page')

  // The authority for a ref is the page, not the row we just read.
  const registry = sandbox['__hanekawaBrowserElements'] as { snapshotId: string; elements: Map<string, unknown> }
  assert.equal(registry.snapshotId, 'snapshot-1')
  assert.equal(registry.elements.size, 2)
})

test('open shadow roots are walked, and slotted light children are not lost', () => {
  const body = el('body', {
    children: [
      el('my-widget', {
        shadow: [el('button', { text: 'Inside shadow' })],
        children: [el('button', { text: 'Slotted' })],
      }),
    ],
  })
  const names = runElements(body).result.rows.map((row) => row.name)
  assert.deepEqual(new Set(names), new Set(['Inside shadow', 'Slotted']))
})

test('a transparent ancestor hides a descendant across the shadow boundary', () => {
  const body = el('body', {
    children: [
      el('my-widget', {
        style: { opacity: '0' },
        shadow: [el('button', { text: 'Invisible' })],
      }),
    ],
  })
  assert.equal(runElements(body).result.rows.length, 0)
  // With the visibility filter off it is reported, and marked for what it is.
  const relaxed = runElements(body, { visibleOnly: false }).result
  assert.equal(relaxed.rows.length, 1)
  assert.equal(relaxed.rows[0]?.visible, undefined)
})

test('a rendered element outside the viewport is marked offscreen, one inside is not', () => {
  // The stub window is 1280×720.
  const body = el('body', {
    children: [
      el('button', { text: 'In view', at: { top: 700, left: 0 } }),
      el('button', { text: 'Below the fold', at: { top: 720, left: 0 } }),
      el('button', { text: 'Scrolled past', at: { top: -20, left: 0 } }),
      el('button', { text: 'Off to the right', at: { top: 10, left: 1280 } }),
    ],
  })
  const rows = runElements(body).result.rows
  assert.deepEqual(
    rows.map((row) => [row.name, row.offscreen === true]),
    [
      ['In view', false],
      ['Below the fold', true],
      ['Scrolled past', true],
      ['Off to the right', true],
    ],
  )
  // Offscreen is a kind of visible, never a substitute for it.
  assert.ok(rows.every((row) => row.visible === true))

  const hidden = el('body', {
    children: [el('button', { text: 'Hidden', style: { display: 'none' }, at: { top: 5000, left: 0 } })],
  })
  assert.equal(runElements(hidden, { visibleOnly: false }).result.rows[0]?.offscreen, undefined)
})

test('a password field projects neither its text nor its value', () => {
  const body = el('body', {
    children: [
      el('input', { attrs: { type: 'password', 'aria-label': 'Password' }, props: { value: 'hunter2' } }),
      el('input', { attrs: { type: 'text', autocomplete: 'one-time-code' }, props: { value: '123456' } }),
      el('input', { attrs: { type: 'text', 'aria-label': 'Search' }, props: { value: 'kittens' } }),
    ],
  })
  const rows = runElements(body).result.rows
  assert.equal(rows[0]?.name, 'Password')
  assert.equal(rows[0]?.value, undefined)
  assert.equal(rows[0]?.text, undefined)
  assert.equal(rows[1]?.value, undefined)
  // The ordinary field is untouched: suppression is targeted, not blanket.
  assert.equal(rows[2]?.value, 'kittens')
})

test('a pointer leaf counts as a button; a pointer container does not', () => {
  const inner = el('span', { text: 'Click me', style: { cursor: 'pointer' } })
  const body = el('body', {
    children: [el('div', { style: { cursor: 'pointer' }, children: [inner] })],
  })
  const rows = runElements(body).result.rows
  assert.deepEqual(
    rows.map((row) => row.name),
    ['Click me'],
  )
})

test('the result budget truncates, and says so', () => {
  const body = el('body', {
    children: Array.from({ length: 10 }, (_, index) => el('button', { text: `B${index}` })),
  })
  const result = runElements(body, { maxResults: 3 }).result
  assert.equal(result.rows.length, 3)
  assert.equal(result.truncated, true)
})

test('the node budget truncates before the walk finishes', () => {
  const body = el('body', {
    children: Array.from({ length: 50 }, (_, index) => el('button', { text: `B${index}` })),
  })
  const result = runElements(body, { maxNodes: 5 }).result
  assert.equal(result.truncated, true)
  assert.ok(result.scanned <= 5)
})

test('role and text filters run in the page', () => {
  const body = el('body', {
    children: [
      el('a', { attrs: { href: '/a' }, text: 'Apples' }),
      el('a', { attrs: { href: '/b' }, text: 'Bananas' }),
      el('button', { text: 'Apples too' }),
    ],
  })
  assert.deepEqual(
    runElements(body, { role: 'link' }).result.rows.map((row) => row.name),
    ['Apples', 'Bananas'],
  )
  assert.deepEqual(
    runElements(body, { text: 'apples' }).result.rows.map((row) => row.name),
    ['Apples', 'Apples too'],
  )
})

test('the focused element is marked', () => {
  const focused = el('input', { attrs: { type: 'text', 'aria-label': 'Query' } })
  const body = el('body', { children: [focused, el('button', { text: 'Go' })] })
  const rows = runElements(body, {}, focused).result.rows
  assert.equal(rows[0]?.focused, true)
  assert.equal(rows[1]?.focused, undefined)
})

test('disabled and required come from the property or the ARIA attribute', () => {
  const body = el('body', {
    children: [
      el('button', { text: 'Off', props: { disabled: true } }),
      el('div', { attrs: { role: 'textbox', 'aria-required': 'true' }, text: 'Needed' }),
    ],
  })
  const rows = runElements(body).result.rows
  assert.equal(rows[0]?.disabled, true)
  assert.equal(rows[1]?.required, true)
})

test('a scope that matches nothing is the caller’s error, with the code to prove it', () => {
  const body = el('body', { children: [el('button', { text: 'Save' })] })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }
  const raw = vm.runInNewContext(elementsScript(elementOptions({ scope: '#missing' })), sandbox)
  assert.throws(
    () => unwrap<ElementScanResult>(raw),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('a scope narrows the scan to its subtree', () => {
  const body = el('body', {
    children: [
      el('nav', { attrs: { id: 'nav' }, children: [el('a', { attrs: { href: '/x' }, text: 'In nav' })] }),
      el('a', { attrs: { href: '/y' }, text: 'Outside' }),
    ],
  })
  assert.deepEqual(
    runElements(body, { scope: '#nav' }).result.rows.map((row) => row.name),
    ['In nav'],
  )
})

// --- the action scripts ------------------------------------------------------

function targetOptions(overrides: Partial<TargetOptions> = {}): TargetOptions {
  return {
    nameMax: FIELD_MAX_NAME,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    scrollIntoView: true,
    focus: false,
    requireEnabled: true,
    ...overrides,
  }
}

/** Resolves against a sandbox a scan has already run in, so refs exist. */
function runResolve(sandbox: Record<string, unknown>, overrides: Partial<TargetOptions>): TargetResult {
  return unwrap<TargetResult>(serialize(vm.runInNewContext(resolveScript(targetOptions(overrides)), sandbox)))
}

function runCondition(sandbox: Record<string, unknown>, overrides: Partial<ConditionOptions>): ConditionResult {
  const options: ConditionOptions = {
    state: 'visible',
    maxNodes: SCAN_MAX_NODES,
    budgetMs: SCAN_BUDGET_MS,
    segmentMax: FIELD_MAX_TEXT,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    ...overrides,
  }
  return unwrap<ConditionResult>(serialize(vm.runInNewContext(conditionScript(options), sandbox)))
}

function runScroll(sandbox: Record<string, unknown>, overrides: Partial<ScrollOptions>): ScrollResult {
  const options: ScrollOptions = { direction: 'down', viewportFraction: 0.9, ...overrides }
  return unwrap<ScrollResult>(serialize(vm.runInNewContext(scrollScript(options), sandbox)))
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof BrowserHostError && error.code === code
}

test('a snapshot ref resolves to a point, and dies with its node', () => {
  const link = el('a', { attrs: { href: '/home' }, text: 'Home' })
  const body = el('body', { children: [link, el('button', { text: 'Save' })] })
  const { sandbox } = runElements(body)

  const target = runResolve(sandbox, { ref: 'e1' })
  assert.equal(target.role, 'link')
  assert.equal(target.name, 'Home')
  assert.deepEqual([target.x, target.y], [50, 10])
  assert.equal(link.scrolledIntoView, true, 'a click has to bring its element on screen first')

  link.isConnected = false
  assert.throws(() => runResolve(sandbox, { ref: 'e1' }), hasCode('STALE_ELEMENT'))
  assert.throws(() => runResolve(sandbox, { ref: 'e9' }), hasCode('STALE_ELEMENT'))
})

test('an invisible element cannot be clicked; a disabled one only when asked', () => {
  const body = el('body', {
    children: [
      el('button', { attrs: { id: 'gone' }, text: 'Gone', size: { width: 0, height: 0 } }),
      el('button', { attrs: { id: 'off' }, text: 'Off', props: { disabled: true } }),
    ],
  })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }

  assert.throws(() => runResolve(sandbox, { selector: '#gone' }), hasCode('ELEMENT_NOT_INTERACTABLE'))
  assert.throws(() => runResolve(sandbox, { selector: '#off' }), hasCode('ELEMENT_NOT_INTERACTABLE'))
  assert.equal(runResolve(sandbox, { selector: '#off', requireEnabled: false }).role, 'button')
  assert.throws(() => runResolve(sandbox, { selector: '#absent' }), hasCode('STALE_ELEMENT'))
  assert.throws(() => runResolve(sandbox, {}), hasCode('INVALID_REQUEST'))
})

test('typing refuses the field that will not take focus', () => {
  const body = el('body', {
    children: [
      el('input', { attrs: { id: 'query', type: 'text', 'aria-label': 'Query' } }),
      el('input', { attrs: { id: 'locked', type: 'text', 'aria-label': 'Locked' }, props: { focusable: false } }),
    ],
  })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }

  const focused = runResolve(sandbox, { selector: '#query', focus: true })
  assert.equal(focused.focused, true)
  assert.throws(() => runResolve(sandbox, { selector: '#locked', focus: true }), hasCode('ELEMENT_NOT_INTERACTABLE'))
})

test('a password field resolves but is marked, so nothing echoes its name', () => {
  const body = el('body', { children: [el('input', { attrs: { id: 'pw', type: 'password', 'aria-label': 'Password' } })] })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }
  assert.equal(runResolve(sandbox, { selector: '#pw' }).sensitive, true)
})

test('a condition is about what is visible, and says what it saw', () => {
  const body = el('body', {
    children: [
      el('p', { attrs: { id: 'status' }, text: 'Loaded' }),
      el('p', { text: 'Spinner', style: { display: 'none' } }),
    ],
  })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }

  const found = runCondition(sandbox, { text: 'loaded' })
  assert.equal(found.matched, true)
  assert.match(found.observed, /found "loaded" in: Loaded/)
  assert.equal(found.url, 'https://stub.test/page')

  assert.equal(runCondition(sandbox, { text: 'Spinner' }).matched, false)
  // Hidden is the same observation, read the other way round.
  assert.equal(runCondition(sandbox, { text: 'Spinner', state: 'hidden' }).matched, true)

  const bySelector = runCondition(sandbox, { selector: '#status' })
  assert.equal(bySelector.matched, true)
  assert.match(bySelector.observed, /#status is visible/)

  const missing = runCondition(sandbox, { selector: '#nope' })
  assert.equal(missing.matched, false)
  assert.match(missing.observed, /no element matches #nope/)
  assert.equal(runCondition(sandbox, { selector: '#nope', state: 'hidden' }).matched, true)

  const split = documentFor(el('body', { children: [el('p', { nodes: ['Order ', el('b', { text: 'confirmed' })] })] }))
  assert.equal(runCondition({ document: split, window: windowFor() }, { text: 'Order confirmed' }).matched, true)

  // A selector plus a text is a search inside that subtree.
  assert.equal(runCondition(sandbox, { selector: '#status', text: 'Loaded' }).matched, true)
  assert.equal(runCondition(sandbox, { selector: '#status', text: 'Spinner' }).matched, false)
})

test('a text that was not seen is only "hidden" when the whole page was looked at', () => {
  const body = el('body', { children: Array.from({ length: 20 }, (_, index) => el('p', { text: `Row ${index}` })) })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }
  assert.equal(runCondition(sandbox, { text: 'Spinner', state: 'hidden' }).matched, true)
  const cut = runCondition(sandbox, { text: 'Spinner', state: 'hidden', maxNodes: 5 })
  assert.equal(cut.matched, false)
  assert.match(cut.observed, /hit its budget/)
})

test('scrolling moves the window and reports where it stopped', () => {
  const far = el('div', { attrs: { id: 'far' } })
  const body = el('body', { props: { scrollHeight: 4000 }, children: [far] })
  const sandbox: Record<string, unknown> = { document: documentFor(body), window: windowFor() }

  const down = runScroll(sandbox, { direction: 'down' })
  assert.equal(down.scrollY, 648)
  assert.equal(down.maxScrollY, 3280)
  assert.equal(down.atBottom, false)
  assert.equal(down.target, 'down 648px')

  assert.equal(runScroll(sandbox, { direction: 'up', amount: 100 }).scrollY, 548)
  const bottom = runScroll(sandbox, { direction: 'bottom' })
  assert.equal(bottom.scrollY, 3280)
  assert.equal(bottom.atBottom, true)
  assert.equal(runScroll(sandbox, { direction: 'top' }).scrollY, 0)

  const targeted = runScroll(sandbox, { selector: '#far' })
  assert.equal(targeted.target, 'selector #far')
  assert.equal(far.scrolledIntoView, true)
})

test('text is grouped by block, in reading order, and scripts never contribute', () => {
  const body = el('body', {
    children: [
      el('p', { nodes: ['点击', el('a', { attrs: { href: '/x' }, text: '这里' }), '继续'] }),
      el('p', { children: [el('span', { text: 'Hello' }), el('span', { text: 'world' })] }),
      el('div', { children: [el('div', { text: 'one' }), el('div', { text: 'two' })] }),
      el('p', { nodes: ['line', el('br'), 'break'] }),
      el('script', { text: 'console.log(1)' }),
      el('p', { text: 'Hidden', style: { display: 'none' } }),
    ],
  })
  const result = runText(body)
  assert.deepEqual(result.blocks, [
    { kind: 'text', text: '点击这里继续' },
    // Two inline spans with no space between them draw as one word.
    { kind: 'text', text: 'Helloworld' },
    { kind: 'text', text: 'one' },
    { kind: 'text', text: 'two' },
    { kind: 'text', text: 'line break' },
  ])
  assert.equal(result.title, 'Stub Page')
})

test('list items, headings and table rows say what they are', () => {
  const body = el('body', {
    children: [
      el('h1', { nodes: ['Orders ', el('small', { text: '(3)' })] }),
      el('ul', { children: [el('li', { children: [el('p', { text: 'first' }), el('p', { text: 'para' })] })] }),
      el('table', {
        children: [el('tr', { children: [el('td', { text: 'Widget' }), el('td', { text: '$4' })] })],
      }),
    ],
  })
  assert.deepEqual(runText(body).blocks, [
    { kind: 'heading', text: 'Orders (3)' },
    { kind: 'item', text: 'first para' },
    { kind: 'row', text: 'Widget $4' },
  ])
})

test('a long block is split across rows, never cut, and never through an emoji', () => {
  // 9 characters then an emoji that straddles the 10-character boundary.
  const body = el('body', { children: [el('p', { text: 'abcdefghi😀jklmnopqrstuvwxyz' })] })
  const blocks = runText(body, { segmentMax: 10 }).blocks
  assert.deepEqual(blocks.map((block) => block.kind), ['text', 'text+', 'text+'])
  assert.equal(blocks[0]?.text, 'abcdefghi')
  assert.equal(blocks[1]?.text, '😀jklmnopq')
  assert.equal(blocks.map((block) => block.text).join(''), 'abcdefghi😀jklmnopqrstuvwxyz')
})

test('the text walk follows the rendered tree: shadow content once, slotted content in its slot', () => {
  const slotted = el('span', { text: 'slotted' })
  const body = el('body', {
    children: [
      el('my-card', {
        children: [slotted],
        shadow: [el('p', { nodes: ['before ', el('slot', { assigned: [slotted] }), ' after'] })],
      }),
      el('input', { attrs: { type: 'text' }, props: { value: 'typed' }, text: 'never' }),
      el('div', { attrs: { autocomplete: 'one-time-code' }, text: '123456' }),
    ],
  })
  assert.deepEqual(runText(body).blocks, [{ kind: 'text', text: 'before slotted after' }])
})

// --- aiming: the hit test and the guard ----------------------------------------

function runGuard(sandbox: Record<string, unknown>, overrides: Partial<GuardOptions>): boolean {
  const options: GuardOptions = {
    mode: 'pointer',
    label: 'ref e1',
    nameMax: FIELD_MAX_NAME,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    ...overrides,
  }
  return unwrap<boolean>(serialize(vm.runInNewContext(guardScript(options), sandbox)))
}

test('a click target under an overlay is refused, naming what covers it', () => {
  const button = el('button', { attrs: { id: 'buy' }, text: 'Buy' })
  const banner = el('div', { attrs: { role: 'dialog', 'aria-label': 'Cookie consent' } })
  const body = el('body', { children: [button, banner] })
  const sandbox: Record<string, unknown> = { document: documentFor(body, null, () => banner), window: windowFor() }

  assert.throws(
    () => runResolve(sandbox, { selector: '#buy', requireHit: true }),
    (error: unknown) =>
      error instanceof BrowserHostError &&
      error.code === 'ELEMENT_NOT_INTERACTABLE' &&
      /covered by <div role=dialog> "Cookie consent"/.test(error.message) &&
      /Dismiss or close it first/.test(error.message),
  )
  // Typing does not go through the hit test, so it does not ask for one.
  assert.equal(runResolve(sandbox, { selector: '#buy' }).role, 'button')
})

test('a press on the icon inside a button, or inside its shadow root, is a press on the button', () => {
  const icon = el('svg')
  const button = el('button', { attrs: { id: 'go' }, children: [icon] })
  const inner = el('span')
  const host = el('my-button', { attrs: { id: 'host' }, shadow: [inner] })
  ;(host.shadowRoot as StubShadowRoot).elementFromPoint = () => inner
  const body = el('body', { children: [button, host] })

  let top: StubElement = icon
  const sandbox: Record<string, unknown> = { document: documentFor(body, null, () => top), window: windowFor() }
  assert.equal(runResolve(sandbox, { selector: '#go', requireHit: true }).role, 'button')

  // `document.elementFromPoint` stops at the host; the shadow root knows better.
  top = host
  assert.equal(runResolve(sandbox, { selector: '#host', requireHit: true }).role, 'my-button')
})

test('a box taller than the viewport is aimed at the middle of its visible part', () => {
  // The window is 1280×720; the panel starts 200px down and runs 2000px.
  const panel = el('div', { attrs: { id: 'panel' }, size: { width: 400, height: 2000 }, at: { top: 200, left: -100 } })
  const body = el('body', { children: [panel] })
  const sandbox: Record<string, unknown> = { document: documentFor(body, null, () => panel), window: windowFor() }
  const target = runResolve(sandbox, { selector: '#panel', requireHit: true })
  assert.deepEqual([target.x, target.y], [150, 460])

  const gone = el('div', { attrs: { id: 'gone' }, at: { top: 900, left: 0 } })
  const off = { document: documentFor(el('body', { children: [gone] })), window: windowFor() }
  assert.throws(() => runResolve(off, { selector: '#gone' }), /off screen/)
})

test('the guard refuses a target that was removed, covered, or lost focus since the resolve', () => {
  const field = el('input', { attrs: { id: 'q', type: 'text', 'aria-label': 'Query' } })
  const popup = el('div', { attrs: { role: 'menu', 'aria-label': 'Suggestions' } })
  const body = el('body', { children: [field, popup] })
  let top: StubElement = field
  const doc = documentFor(body, null, () => top)
  const sandbox: Record<string, unknown> = { document: doc, window: windowFor() }

  runResolve(sandbox, { selector: '#q', focus: true })
  assert.equal(runGuard(sandbox, { mode: 'pointer', x: 50, y: 10 }), true)
  assert.equal(runGuard(sandbox, { mode: 'keyboard' }), true)

  top = popup
  assert.throws(() => runGuard(sandbox, { mode: 'pointer', x: 50, y: 10 }), /no longer under the pointer; <div role=menu> "Suggestions" is/)

  doc['activeElement'] = popup
  assert.throws(() => runGuard(sandbox, { mode: 'keyboard' }), hasCode('ELEMENT_NOT_INTERACTABLE'))

  field.isConnected = false
  assert.throws(() => runGuard(sandbox, { mode: 'keyboard' }), hasCode('STALE_ELEMENT'))
})

test('focus inside an open shadow root counts as focus on the element that holds it', () => {
  const inner = el('input', { attrs: { type: 'text' } })
  const host = el('my-field', { attrs: { id: 'field' }, shadow: [inner] })
  const body = el('body', { children: [host] })
  const sandbox: Record<string, unknown> = { document: documentFor(body, host), window: windowFor() }
  ;(host.shadowRoot as StubShadowRoot).activeElement = inner
  assert.equal(runResolve(sandbox, { selector: '#field' }).focused, true)
})
