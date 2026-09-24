/**
 * The contract between the `Browser` tool and whatever owns real tabs.
 *
 * It lives here, in the Electron-free protocol layer, because the two sides may
 * not see each other: `src/tools/` is shared with the TUI and must never import
 * Electron, and `src/desktop/browser/` is nothing but Electron. Types are the
 * only thing that crosses.
 *
 * Every call is scoped by a `BrowserCaller` — a session and its current turn — rather than by a lane. The tool knows
 * which conversation it is running in and nothing about the window's topology;
 * resolving a session to a lane — and, from phase 5, deciding whether that
 * session still holds the browser — belongs to the implementation.
 *
 * Failures are thrown, not returned: the implementation raises an error
 * carrying a `code` (and, for the ones worth retrying, `retryable: true`), and
 * the tool renders it. Nothing here imports that error class, so the shape is
 * read structurally.
 */

export interface BrowserTabState {
  tabId: string
  /** The committed URL, or `''` for a tab that has never navigated. */
  url: string
  title: string
  loading: boolean
  /** The last navigation failure, cleared when a new navigation starts. */
  error?: string
  /** The user took this tab back; from phase 5 that also blocks the agent. */
  takenOver?: boolean
  /** Downloads the page started, cancelled by the browser: their file names, oldest first. */
  blockedDownloads?: string[]
}

/** One page of a projection, already rendered. The tool passes it through. */
export interface BrowserSnapshot {
  text: string
  snapshotId: string
  /** Present only while there is more to read. Feed it back verbatim. */
  cursor?: string
  scanTruncated: boolean
  total: number
}

export interface BrowserScreenshot {
  bytes: Buffer
  name: string
  width: number
  height: number
}

export interface BrowserElementsRequest {
  scope?: string
  role?: string
  text?: string
  interactiveOnly?: boolean
  visibleOnly?: boolean
  limit?: number
  maxChars?: number
}

export interface BrowserTextRequest {
  scope?: string
  visibleOnly?: boolean
  limit?: number
  maxChars?: number
}

/**
 * What an action points at: a `ref` from the latest element snapshot, or a CSS
 * selector. A ref wins when both are given — it names the element the model
 * actually read, while a selector is re-resolved against whatever matches now.
 */
export interface BrowserTarget {
  ref?: string
  selector?: string
}

export interface BrowserClickRequest extends BrowserTarget {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  signal?: AbortSignal
}

export interface BrowserTypeRequest extends BrowserTarget {
  text: string
  clear?: boolean
  submit?: boolean
  signal?: AbortSignal
}

/** No target means the keys go to whatever has focus. */
export interface BrowserPressKeyRequest extends BrowserTarget {
  keys: string[]
  signal?: AbortSignal
}

/** Exactly one of `value`, `label` and `index`. */
export interface BrowserSelectRequest extends BrowserTarget {
  value?: string
  label?: string
  index?: number
  signal?: AbortSignal
}

export interface BrowserSetCheckedRequest extends BrowserTarget {
  checked: boolean
  signal?: AbortSignal
}

export interface BrowserScrollRequest extends BrowserTarget {
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  signal?: AbortSignal
}

export interface BrowserWaitRequest {
  selector?: string
  text?: string
  state?: 'visible' | 'hidden'
  /** The committed URL to wait for; `urlMatch` defaults to `prefix`. */
  url?: string
  urlMatch?: 'exact' | 'prefix' | 'contains'
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * What an action did, in one line the transcript keeps.
 *
 * Deliberately not a page projection: an action's answer is evidence about the
 * action, and reading the result is a separate, explicit snapshot. Nothing here
 * ever carries the text that was typed.
 */
export interface BrowserActionResult {
  text: string
}

/**
 * Who is calling, and on which turn.
 *
 * The turn is half of the address, not decoration: a takeover blocks a session
 * only until its next turn, so the implementation has to be able to tell one
 * turn from the next. It is optional because a caller outside a turn (a probe,
 * a test) still has a session, and the arbitration reads "no turn" as "nothing
 * has changed" rather than inventing one.
 */
export interface BrowserCaller {
  sessionId: string
  turnId?: string
}

/** The tab's own history buttons: the three navigations that need no URL. */
export type BrowserHistoryAction = 'back' | 'forward' | 'reload'

export interface BrowserHost {
  listTabs(caller: BrowserCaller): Promise<BrowserTabState[]>
  createTab(caller: BrowserCaller, url?: string): Promise<BrowserTabState>
  closeTab(caller: BrowserCaller, tabId: string): Promise<void>
  navigate(caller: BrowserCaller, tabId: string, url: string): Promise<BrowserTabState>
  /** Refuses a back or forward with nowhere to go rather than doing nothing. */
  history(caller: BrowserCaller, tabId: string, action: BrowserHistoryAction): Promise<BrowserTabState>
  /**
   * Resolves once the tab's *current* navigation finished loading. A navigation
   * that starts while this is waiting replaces what it is waiting for — the
   * answer is always about the document the tab ends up on.
   */
  waitForLoad(
    caller: BrowserCaller,
    tabId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<BrowserTabState>
  elements(caller: BrowserCaller, tabId: string, request: BrowserElementsRequest): Promise<BrowserSnapshot>
  text(caller: BrowserCaller, tabId: string, request: BrowserTextRequest): Promise<BrowserSnapshot>
  /** Reads the next page of a snapshot already taken. Never touches the page. */
  readSnapshot(caller: BrowserCaller, tabId: string, cursor: string, maxChars?: number): Promise<BrowserSnapshot>
  screenshot(caller: BrowserCaller, tabId: string): Promise<BrowserScreenshot>
  click(caller: BrowserCaller, tabId: string, request: BrowserClickRequest): Promise<BrowserActionResult>
  type(caller: BrowserCaller, tabId: string, request: BrowserTypeRequest): Promise<BrowserActionResult>
  pressKey(caller: BrowserCaller, tabId: string, request: BrowserPressKeyRequest): Promise<BrowserActionResult>
  selectOption(caller: BrowserCaller, tabId: string, request: BrowserSelectRequest): Promise<BrowserActionResult>
  /** Clicks only when the control is not already in the asked-for state. */
  setChecked(caller: BrowserCaller, tabId: string, request: BrowserSetCheckedRequest): Promise<BrowserActionResult>
  scroll(caller: BrowserCaller, tabId: string, request: BrowserScrollRequest): Promise<BrowserActionResult>
  /** Polls a condition about the page's contents, not about its load state. */
  waitFor(caller: BrowserCaller, tabId: string, request: BrowserWaitRequest): Promise<BrowserActionResult>
}
