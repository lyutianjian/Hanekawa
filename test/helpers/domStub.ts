/**
 * A hand-written DOM stand-in for the renderer's `dom/` modules.
 *
 * There is no jsdom in `devDependencies` and this file is not an argument for
 * adding one: the whole of `dom/dom.ts`, `dom/controls.ts` and `dom/icons.ts`
 * reaches for exactly four `document` members and a dozen element members, so a
 * real DOM implementation would be two orders of magnitude more machinery than
 * the thing under test.
 *
 * The honest cost: this stub is **not** type-checked against `Document`, so a
 * helper that grows a new DOM call would keep passing against a shape the browser
 * never sees. `test/rendererWelcomeView.test.ts` closes that with a source scan —
 * it reads those three files, extracts every `document.<member>`, and asserts the
 * stub has it. That guard is not optional; without it this file is the kind of
 * fake `todo.md` records under 「断言只值它的假货那么多钱」.
 *
 * Installation writes `globalThis.document` and `uninstall()` deletes it again.
 * Contamination is bounded even so: `node --test` runs one process per file, and
 * all three helpers read `document` inside function bodies rather than capturing
 * it at import time.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Populated by `setAttribute('id', …)`; cleared by `uninstall()`. */
const ID_REGISTRY = new Map<string, StubElement>()

interface StubEvent {
  readonly type: string
  /** The node the event started on. Defaults to the node it is dispatched on. */
  readonly target: unknown
  /** `focusout`'s incoming node. `null` is "focus left the document", which is
   *  also what a view's own `replace()` produces — handlers must tell them apart. */
  readonly relatedTarget: unknown
  readonly key: string
  defaultPrevented: boolean
  preventDefault(): void
  stopPropagation(): void
}

/** What `dispatch` may override on the synthetic event. */
export interface StubEventInit {
  readonly target?: unknown
  readonly relatedTarget?: unknown
  readonly key?: string
}

type Listener = (event: StubEvent) => void

/** A text node. Kept separate so `nodes` can report the interleaving. */
class StubText {
  parent: StubElement | undefined
  constructor(public data: string) {}
}

type StubChild = StubElement | StubText

class StubElement {
  readonly attributes = new Map<string, string>()
  readonly childNodes: StubChild[] = []
  readonly listeners = new Map<string, Listener[]>()
  parent: StubElement | undefined
  hidden = false
  disabled = false
  type = ''
  title = ''
  value = ''
  placeholder = ''
  /**
   * Scroll metrics. There is no layout here, so a test sets them with
   * `setMetrics` and the view reads them exactly as it would in the browser.
   */
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  /**
   * The one inline style the renderer is allowed to write (`autosize` clamps a
   * `scrollHeight` no stylesheet can compute — `rendererStyleTokens.test.ts`
   * enforces that it stays the only one).
   */
  readonly style: { height: string } = { height: '' }
  /** A textarea's caret. `setSelectionRange` moves it, as in the browser. */
  selectionStart = 0

  setSelectionRange(start: number, _end: number): void {
    this.selectionStart = start
  }

  /**
   * As `Element.scrollTo({ top })`, and it fires `scroll` — synchronously here,
   * asynchronously (and repeatedly, under `behavior: 'smooth'`) in the browser.
   * A view that relies on that event to repaint is therefore tested on the same
   * path it takes for real, instead of on an assumption about the click handler.
   */
  scrollTo(options: { top?: number }): void {
    if (options.top !== undefined) this.scrollTop = options.top
    this.dispatch('scroll')
  }

  constructor(readonly tagName: string, readonly namespaceURI: string | undefined) {}

  /** Backed by the `class` attribute, as in the real DOM — `icons.ts` sets it that way. */
  get className(): string {
    return this.attributes.get('class') ?? ''
  }

  set className(value: string) {
    this.attributes.set('class', value)
  }

  readonly classList = {
    add: (...names: string[]): void => {
      const present = new Set(this.className.split(/\s+/).filter(Boolean))
      for (const name of names) present.add(name)
      this.className = [...present].join(' ')
    },
    remove: (...names: string[]): void => {
      const present = new Set(this.className.split(/\s+/).filter(Boolean))
      for (const name of names) present.delete(name)
      this.className = [...present].join(' ')
    },
    toggle: (name: string, force?: boolean): void => {
      const on = force ?? !this.classes.includes(name)
      if (on) this.classList.add(name)
      else this.classList.remove(name)
    },
    contains: (name: string): boolean => this.classes.includes(name),
  }

  get classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean)
  }

  /**
   * A real accessor pair, not a property: `selectField` writes it (expecting the
   * children to be replaced by one text node) and the tests read it (expecting
   * the whole subtree concatenated). A plain field silently breaks one of the two.
   */
  get textContent(): string {
    return this.childNodes
      .map((child) => (child instanceof StubText ? child.data : child.textContent))
      .join('')
  }

  set textContent(value: string) {
    this.replaceChildren()
    if (value !== '') this.appendChild(new StubText(value))
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    // So `getElementById` is not a permanent `null`. `dom.ts`'s `required()`
    // throws on a miss, and a stub that always missed would make every future
    // test of an id-mounted view look like an index.html mismatch.
    if (name === 'id') ID_REGISTRY.set(value, this)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  appendChild<T extends StubChild>(child: T): T {
    child.parent?.removeChild(child)
    child.parent = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: StubChild): void {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parent = undefined
  }

  remove(): void {
    this.parent?.removeChild(this)
  }

  replaceChildren(...children: StubChild[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child)
    for (const child of children) this.appendChild(child)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type)
    if (list) list.push(listener)
    else this.listeners.set(type, [listener])
  }

  /** As `Node.contains`: true for itself and any descendant. */
  contains(other: unknown): boolean {
    for (let at = other; at instanceof StubElement; at = at.parent) {
      if (at === this) return true
    }
    return false
  }

  /**
   * Records focus. There is no bubbling `focusin`/`focusout` here: a view that
   * closes a menu on focus loss is tested by dispatching `focusout` on the
   * container with an explicit `relatedTarget`, which is what the browser hands it.
   */
  focus(): void {
    activeElement = this
  }

  dispatch(type: string, init: StubEventInit = {}): StubEvent {
    const event: StubEvent = {
      type,
      target: init.target ?? this,
      relatedTarget: init.relatedTarget ?? null,
      key: init.key ?? '',
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true
      },
      stopPropagation() {},
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event
  }
}

/** The focused node, as `document.activeElement`. Cleared by `uninstall()`. */
let activeElement: StubElement | undefined

/** What a test may ask about a rendered node. Read-only, and identity-preserving. */
export interface StubView {
  /** Upper-case for HTML, verbatim for SVG — the same as the real DOM. */
  readonly tagName: string
  readonly className: string
  readonly classes: readonly string[]
  readonly hidden: boolean
  readonly disabled: boolean
  /** `textContent` of the whole subtree. */
  readonly text: string
  readonly attributes: ReadonlyMap<string, string>
  /** Element children only. */
  readonly children: readonly StubView[]
  /** Element and text children interleaved, in document order. */
  readonly nodes: readonly (StubView | string)[]
  /** Where the scroller is, so "followed the tail" is assertable. */
  readonly scrollTop: number
  /** The node itself, for asserting nothing was rebuilt between renders. */
  readonly node: unknown
}

export interface DomStub {
  /** A mount point, typed for the view factories' `HTMLElement` parameter. */
  createContainer(className?: string): HTMLElement
  /** Everything a test may read about a node built through this stub. */
  inspect(node: unknown): StubView
  /** Fires a `click`, as `controls.ts`'s `button()` listens for. */
  click(node: unknown): void
  /**
   * Fires any other event. `init.target` is what a delegating handler reads to
   * decide whether the event was aimed at one of its own persistent children;
   * `init.relatedTarget` is `focusout`'s destination; `init.key` is for `keydown`.
   */
  dispatch(node: unknown, type: string, init?: StubEventInit): void
  /** Moves focus, so `activeElement` can be asserted after a keyboard intent. */
  focus(node: unknown): void
  /**
   * Stands in for layout: a scroll container's metrics. Only the members given
   * are written, so a test can move `scrollTop` alone without restating the size.
   */
  setMetrics(node: unknown, metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }): void
  /** The focused node, or `undefined`. */
  activeElement(): unknown
  /** Whether the stub's `document` carries a member, for the source-scan guard. */
  hasDocumentMember(name: string): boolean
  uninstall(): void
}

function asElement(node: unknown): StubElement {
  if (node instanceof StubElement) return node
  throw new Error('Not a node built by this stub — the view reached past `dom/`')
}

function viewOf(element: StubElement): StubView {
  return {
    tagName: element.tagName,
    className: element.className,
    classes: element.classes,
    hidden: element.hidden,
    disabled: element.disabled,
    text: element.textContent,
    attributes: element.attributes,
    children: element.childNodes.filter((c): c is StubElement => c instanceof StubElement).map(viewOf),
    nodes: element.childNodes.map((child) => (child instanceof StubText ? child.data : viewOf(child))),
    scrollTop: element.scrollTop,
    node: element,
  }
}

export function installDomStub(): DomStub {
  const document = {
    createElement(tag: string): StubElement {
      return new StubElement(tag.toUpperCase(), undefined)
    },
    createElementNS(ns: string, tag: string): StubElement {
      return new StubElement(ns === SVG_NS ? tag : tag.toUpperCase(), ns)
    },
    createTextNode(data: string): StubText {
      return new StubText(data)
    },
    getElementById(id: string): StubElement | null {
      return ID_REGISTRY.get(id) ?? null
    },
    // Present because the source scan counts a mention in a comment too, and
    // `controls.ts` explains there why it reads `event.target` *instead* of this.
    // Cheap to answer honestly, and it keeps the guard from needing an exception.
    get activeElement(): StubElement | undefined {
      return activeElement
    },
  }

  Reflect.set(globalThis, 'document', document)
  // `focusout` handlers narrow `event.relatedTarget` with `instanceof Node` before
  // calling `contains`. Without a `Node` binding that line is a ReferenceError, so
  // the stub answers for it: every node it builds is a `StubElement`.
  Reflect.set(globalThis, 'Node', StubElement)

  return {
    createContainer(className?: string): HTMLElement {
      const element = new StubElement('DIV', undefined)
      if (className) element.className = className
      // The one cast in this file, and the reason the source-scan guard exists:
      // the stub deliberately does not claim to *be* an `HTMLElement`, so the
      // boundary is crossed once, here, rather than in every test.
      return element as unknown as HTMLElement
    },
    inspect(node: unknown): StubView {
      return viewOf(asElement(node))
    },
    click(node: unknown): void {
      asElement(node).dispatch('click')
    },
    dispatch(node: unknown, type: string, init: StubEventInit = {}): void {
      asElement(node).dispatch(type, init)
    },
    focus(node: unknown): void {
      asElement(node).focus()
    },
    setMetrics(node, metrics): void {
      const element = asElement(node)
      if (metrics.scrollTop !== undefined) element.scrollTop = metrics.scrollTop
      if (metrics.scrollHeight !== undefined) element.scrollHeight = metrics.scrollHeight
      if (metrics.clientHeight !== undefined) element.clientHeight = metrics.clientHeight
    },
    activeElement(): unknown {
      return activeElement
    },
    hasDocumentMember(name: string): boolean {
      return Object.hasOwn(document, name)
    },
    uninstall(): void {
      ID_REGISTRY.clear()
      activeElement = undefined
      Reflect.deleteProperty(globalThis, 'document')
      Reflect.deleteProperty(globalThis, 'Node')
    },
  }
}
