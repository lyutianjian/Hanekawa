/**
 * A hand-written DOM stand-in for the renderer's `dom/` modules.
 *
 * There is no jsdom in `devDependencies` and this file is not an argument for
 * adding one: the whole of `dom/dom.ts`, `dom/controls.ts` and `dom/icons.ts`
 * reaches for a handful of `document` members and a dozen element members, so a
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
 * The scan covers `document.<member>` only, so the **element** members faked
 * here are unguarded and the list keeps growing: `scrollTop`/`scrollHeight`/
 * `clientHeight`/`scrollTo`/`scrollIntoView`/`getBoundingClientRect()`/
 * `style.height`/`selectionStart`/
 * `setSelectionRange`/`dispatch`/`focus`/`contains()`/`closest()`/`dataset`/
 * `insertBefore()`.
 * Add to that list rather than starting a second one.
 *
 * Installation writes `globalThis.document` and `uninstall()` deletes it again.
 * Contamination is bounded even so: `node --test` runs one process per file, and
 * all three helpers read `document` inside function bodies rather than capturing
 * it at import time.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Populated by `setAttribute('id', …)`; cleared by `uninstall()`. */
const ID_REGISTRY = new Map<string, StubElement>()

/**
 * The rule `getBoundingClientRect` answers from, installed by `onLayout`.
 *
 * Module-scoped because `StubElement` is, and cleared by `uninstall` for the
 * same reason `ID_REGISTRY` is: a rule left standing would measure the next
 * file's nodes.
 */
let LAYOUT: ((view: StubView) => { top: number; bottom: number } | undefined) | undefined

interface StubEvent {
  readonly type: string
  /** The node the event started on. Defaults to the node it is dispatched on. */
  readonly target: unknown
  /** `focusout`'s incoming node. `null` is "focus left the document", which is
   *  also what a view's own `replace()` produces — handlers must tell them apart. */
  readonly relatedTarget: unknown
  readonly key: string
  /** `transitionend`'s property. The sidebar's fold listens for `flex-basis`. */
  readonly propertyName: string
  /**
   * The pressed mouse button, as `MouseEvent.button`: 0 is the left one, 2 the
   * right. Defaults to 0, so a test that does not care describes a plain click —
   * the sidebar reads it to tell a left press on an open menu's trigger (a
   * dismissal) from the right-click that toggles the menu.
   */
  readonly button: number
  defaultPrevented: boolean
  preventDefault(): void
  stopPropagation(): void
}

/** What `dispatch` may override on the synthetic event. */
export interface StubEventInit {
  readonly target?: unknown
  readonly relatedTarget?: unknown
  readonly key?: string
  readonly propertyName?: string
  readonly button?: number
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
   * The box, for the views that measure one. There is no layout here, so it
   * comes from the rule a test installed with `onLayout`; without one — which is
   * every test that does not care — it is `NaN`, the same answer the browser
   * gives inside a `display: none` subtree and the one a measuring view has to
   * survive either way.
   */
  getBoundingClientRect(): { top: number; bottom: number } {
    return LAYOUT?.(viewOf(this)) ?? { top: Number.NaN, bottom: Number.NaN }
  }
  /**
   * The inline style, which the renderer may reach in exactly two ways
   * (`rendererStyleTokens.test.ts` enforces both): `height`, because `autosize`
   * clamps a `scrollHeight` no stylesheet can compute, and `setProperty` for a
   * *custom* property — the sidebar's width, whose rules and fallback still
   * live in the sheet.
   */
  readonly style = {
    height: '',
    properties: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      this.properties.set(name, value)
    },
  }
  /** A textarea's caret. `setSelectionRange` moves it, as in the browser. */
  selectionStart = 0
  /**
   * `data-*` attributes, as a plain bag rather than a live view of
   * `attributes`. Nothing reads a `data-` attribute back through
   * `getAttribute`, so the two never have to agree.
   */
  readonly dataset: Record<string, string> = {}

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

  /**
   * A no-op, unlike `scrollTo`: the sidebar's reveal path calls it to bring a
   * workspace heading on screen, and there is no layout here to scroll. Present
   * so calling it is not a `TypeError`, which is the only way the browser could
   * differ from this stub for a method whose return value nobody reads.
   */
  scrollIntoView(): void {}

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

  /**
   * Attribute states that come and go on a *kept* node need this: a view that
   * only ever sets `aria-busy` leaves it on the row forever once the change it
   * announced has landed.
   */
  removeAttribute(name: string): void {
    const previous = this.attributes.get(name)
    this.attributes.delete(name)
    // Mirrors `setAttribute`'s registration, so an id that is taken off a node
    // does not keep answering `getElementById`.
    if (name === 'id' && previous !== undefined) ID_REGISTRY.delete(previous)
  }

  appendChild<T extends StubChild>(child: T): T {
    child.parent?.removeChild(child)
    child.parent = this
    this.childNodes.push(child)
    return child
  }

  /**
   * As `Node.insertBefore`, including the move: a child already in this parent is
   * taken out of its old slot first. `dom.ts`'s `reconcile` is the only caller,
   * and a stub that appended instead would let a mis-ordered paint pass.
   */
  insertBefore<T extends StubChild>(child: T, before: StubChild | null): T {
    child.parent?.removeChild(child)
    child.parent = this
    const at = before === null ? -1 : this.childNodes.indexOf(before)
    if (at >= 0) this.childNodes.splice(at, 0, child)
    else this.childNodes.push(child)
    return child
  }

  removeChild(child: StubChild): void {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parent = undefined
    // A node that leaves the tree takes the focus with it, exactly as the browser
    // does — and `appendChild`/`insertBefore` detach first, so *re-parenting* a
    // focused input blurs it here too. Without this the stub reported focus a real
    // window had already dropped: `settingsView` kept its `<input>` by id but
    // rebuilt the `.settings-row-control` around it, so every keystroke moved the
    // caret to `<body>` while this test double stayed green.
    if (child instanceof StubElement && child.contains(activeElement)) {
      activeElement = undefined
    }
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

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type)
    if (!list) return
    const at = list.indexOf(listener)
    if (at >= 0) list.splice(at, 1)
  }

  /**
   * As `Element.closest`, for the class selectors `dom/dismiss.ts` scopes a
   * popover with. Only `.class` and `#id` lists are understood — that is the
   * whole of what the renderer passes, and a selector engine here would be the
   * kind of fake this file's header warns about. An unsupported selector throws
   * rather than quietly missing, so a view that grows a real one is told.
   */
  closest(selector: string): StubElement | null {
    const parts = selector.split(',').map((part) => part.trim()).filter(Boolean)
    for (const part of parts) {
      if (!/^[.#][A-Za-z0-9_-]+$/.test(part)) {
        throw new Error(`domStub.closest understands '.class' and '#id' only, not '${part}'`)
      }
    }
    for (let at: StubElement | undefined = this; at !== undefined; at = at.parent) {
      for (const part of parts) {
        const matched = part.startsWith('.')
          ? at.classes.includes(part.slice(1))
          : at.getAttribute('id') === part.slice(1)
        if (matched) return at
      }
    }
    return null
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
      propertyName: init.propertyName ?? '',
      button: init.button ?? 0,
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
  /** Custom properties written through `style.setProperty`; see `StubElement.style`. */
  readonly styleProperties: ReadonlyMap<string, string>
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
   *
   * Returns what the handlers left on the event: `defaultPrevented` is the only
   * observable difference between a listener that suppressed the browser's own
   * behaviour and one that did not.
   */
  dispatch(node: unknown, type: string, init?: StubEventInit): { readonly defaultPrevented: boolean }
  /**
   * Fires an event on `document` itself, where the window's global listeners
   * live: the keydown that carries the chords, and the `pointerdown` every
   * popover closes on (`dom/dismiss.ts`).
   *
   * There is no bubbling here, so `init.target` is the whole of what a
   * dismissal handler reads — it is the node the user pressed, not this one.
   */
  dispatchDocument(type: string, init?: StubEventInit): { readonly defaultPrevented: boolean }
  /** Moves focus, so `activeElement` can be asserted after a keyboard intent. */
  focus(node: unknown): void
  /**
   * Stands in for layout: a scroll container's metrics. Only the members given
   * are written, so a test can move `scrollTop` alone without restating the size.
   */
  setMetrics(node: unknown, metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }): void
  /**
   * Stands in for layout the other way round: a rule consulted by
   * `getBoundingClientRect`, rather than a value written onto one node.
   *
   * Which is what a view that measures the nodes it just built needs — those
   * nodes do not exist until the paint that reads them, so there is no moment in
   * which a test could have written a box onto one. A rule keyed off what the
   * node *is* can answer for them. Returning `undefined` for a node leaves it
   * unmeasurable, which is the browser's own answer inside `display: none`.
   */
  onLayout(measure: (view: StubView) => { top: number; bottom: number } | undefined): void
  /** The focused node, or `undefined`. */
  activeElement(): unknown
  /** `<html>`, whose `dataset.theme` the stylesheet reads. */
  documentElement(): unknown
  /** `<body>`, where a failed startup leaves its message. */
  body(): unknown
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
    styleProperties: element.style.properties,
    children: element.childNodes.filter((c): c is StubElement => c instanceof StubElement).map(viewOf),
    nodes: element.childNodes.map((child) => (child instanceof StubText ? child.data : viewOf(child))),
    scrollTop: element.scrollTop,
    node: element,
  }
}

export function installDomStub(): DomStub {
  // The page's two fixed nodes. `<html>` carries `dataset.theme` (the whole
  // stylesheet hangs off it) and `<body>` is where `app.ts` writes the message
  // it shows when startup fails — a test that never looks at it lets a thrown
  // bootstrap pass for a healthy one.
  const documentElement = new StubElement('HTML', undefined)
  const body = new StubElement('BODY', undefined)
  // A listener host for `document.addEventListener`: the global keydown that
  // carries the window's chords is installed there, not on any element.
  const documentNode = new StubElement('#document', undefined)

  const document = {
    documentElement,
    body,
    /** Written by `statusView.renderSession` — the window's own title. */
    title: '',
    /**
     * What `index.html`'s `<!doctype html>` gets the real page. KaTeX reads it
     * and refuses to typeset anything in quirks mode — its own metrics assume
     * standards box sizing — so without this every equation in a DOM test
     * takes the raw-source fallback and the assertions pass vacuously.
     */
    compatMode: 'CSS1Compat',
    addEventListener(type: string, listener: Listener): void {
      documentNode.addEventListener(type, listener)
    },
    // The other half of `addEventListener`, and not decoration: `dom/dismiss.ts`
    // hands its caller an unsubscribe, and a stub that only ever adds would let a
    // view leak a listener past its own teardown without a test noticing.
    removeEventListener(type: string, listener: Listener): void {
      documentNode.removeEventListener(type, listener)
    },
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
  // And `Element`, which `dom/dismiss.ts` narrows to before calling `closest`.
  // The same binding: every node this stub builds is a `StubElement`, and the
  // distinction the browser draws between the two is not one any view reads.
  Reflect.set(globalThis, 'Element', StubElement)

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
    dispatch(node: unknown, type: string, init: StubEventInit = {}): { readonly defaultPrevented: boolean } {
      return asElement(node).dispatch(type, init)
    },
    dispatchDocument(type: string, init: StubEventInit = {}): { readonly defaultPrevented: boolean } {
      return documentNode.dispatch(type, init)
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
    onLayout(measure): void {
      LAYOUT = measure
    },
    activeElement(): unknown {
      return activeElement
    },
    documentElement(): unknown {
      return documentElement
    },
    body(): unknown {
      return body
    },
    hasDocumentMember(name: string): boolean {
      return Object.hasOwn(document, name)
    },
    uninstall(): void {
      ID_REGISTRY.clear()
      LAYOUT = undefined
      activeElement = undefined
      Reflect.deleteProperty(globalThis, 'document')
      Reflect.deleteProperty(globalThis, 'Node')
      Reflect.deleteProperty(globalThis, 'Element')
    },
  }
}
