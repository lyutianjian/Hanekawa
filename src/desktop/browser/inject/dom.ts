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
  readonly shadowRoot: { readonly children: ArrayLike<InjElement> } | null
  matches(selector: string): boolean
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  getBoundingClientRect(): InjRect
  /** Input needs the element on screen before it can aim a real event at it. */
  scrollIntoView(options?: { block?: string; inline?: string }): void
  focus(): void
}

export interface InjDocument {
  readonly documentElement: InjElement | null
  readonly body: InjElement | null
  readonly title: string
  readonly activeElement: InjElement | null
  querySelector(selector: string): InjElement | null
  getElementById(id: string): InjElement | null
}

export interface InjWindow {
  getComputedStyle(element: InjElement): InjStyle
  readonly innerWidth: number
  readonly innerHeight: number
  readonly scrollX: number
  readonly scrollY: number
  scrollBy(x: number, y: number): void
  scrollTo(x: number, y: number): void
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
}
