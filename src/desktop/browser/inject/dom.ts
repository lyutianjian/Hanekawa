/**
 * The slice of the DOM the injected collectors actually touch.
 *
 * The main process is compiled with `lib: ES2022` — no `DOM` — and that absence
 * is load-bearing: it is what stops host code from reaching for `document` as if
 * it had one. These collectors *do* run against a real DOM, but in another
 * process, reached only as source text. So they are typed against structural
 * interfaces declared here instead of against `lib.dom`.
 *
 * The narrowness is a feature. Anything the collectors are allowed to use has to
 * be written down first, which keeps the injected surface auditable: the list
 * below is the complete set of page APIs the automation world calls.
 */

export interface InjRect {
  readonly width: number
  readonly height: number
  readonly top: number
  readonly left: number
}

export interface InjStyle {
  readonly display: string
  readonly visibility: string
  readonly opacity: string
  readonly cursor: string
}

export interface InjNode {
  readonly nodeType: number
  readonly textContent: string | null
  getRootNode(): InjRoot
}

/**
 * An open shadow root, as far as the collectors reach into one.
 *
 * `elementFromPoint` and `activeElement` are optional because the hit test and
 * the focus check drill through them one level at a time and stop wherever a
 * root does not answer.
 */
export interface InjShadowRoot {
  readonly children: ArrayLike<InjElement>
  readonly childNodes: ArrayLike<InjNode>
  readonly activeElement?: InjElement | null
  elementFromPoint?(x: number, y: number): InjElement | null
}

export interface InjEventInit {
  bubbles?: boolean
  composed?: boolean
}

export interface InjRoot extends InjNode {
  /** Present on a `ShadowRoot`, absent on a `Document`. Opacity crosses here. */
  readonly host?: InjElement
}

export interface InjElement extends InjNode {
  readonly tagName: string
  readonly id: string
  readonly children: ArrayLike<InjElement>
  readonly childNodes: ArrayLike<InjNode>
  readonly parentElement: InjElement | null
  /** `null` for a closed shadow root, which is the same as not having one here. */
  readonly shadowRoot: InjShadowRoot | null
  /** Only on `<slot>`: the light nodes rendered in its place. */
  assignedNodes?(options?: { flatten?: boolean }): ArrayLike<InjNode>
  matches(selector: string): boolean
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  getBoundingClientRect(): InjRect
  /** Input needs the element on screen before it can aim a real event at it. */
  scrollIntoView(options?: { block?: string; inline?: string }): void
  focus(): void
  /** `select_option` announces its change the way a user's pick would. */
  dispatchEvent(event: unknown): boolean
}

export interface InjDocument {
  readonly documentElement: InjElement | null
  readonly body: InjElement | null
  readonly title: string
  readonly activeElement: InjElement | null
  querySelector(selector: string): InjElement | null
  getElementById(id: string): InjElement | null
  /** The topmost element at a viewport point: what a real press would land on. */
  elementFromPoint(x: number, y: number): InjElement | null
}

export interface InjWindow {
  getComputedStyle(element: InjElement): InjStyle
  readonly innerWidth: number
  readonly innerHeight: number
  readonly scrollX: number
  readonly scrollY: number
  scrollBy(x: number, y: number): void
  scrollTo(x: number, y: number): void
  /** The page's own `Event`, so a dispatched one belongs to its realm. */
  readonly Event: new (type: string, init?: InjEventInit) => unknown
}

/**
 * Where element refs live: in the page, not here.
 *
 * The main process keeps only the short names it handed back. The authority is
 * this one global in the automation world, which a navigation wipes along with
 * the rest of the world — which is exactly why a ref cannot outlive its
 * document by accident.
 */
export interface InjGlobal {
  __hanekawaBrowserElements?: { snapshotId: string; elements: Map<string, InjElement> }
  /**
   * The element the last resolve settled on, for the guard that runs right
   * before each input command. It is not a ref: nothing outside the page names
   * it, and the next resolve replaces it.
   */
  __hanekawaBrowserTarget?: InjElement
}
