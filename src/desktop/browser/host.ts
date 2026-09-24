/**
 * The desktop's implementation of the agent-facing browser.
 *
 * It is the join between three things that deliberately do not know about each
 * other: the `BrowserHost` contract (pure types, shared with `src/tools/`), the
 * tab container (`tabs.ts`, all Electron), and the projection (`projection.ts`,
 * all arithmetic). Nothing here decides *what* a snapshot looks like; this file
 * only decides which tab a session may address and hands the page over.
 *
 * Sessions, not lanes. The tool knows its caller — a session and its current
 * turn — and nothing about window topology, so every entry point resolves the
 * lane here and refuses a tab that belongs to a different one. That same seat is
 * where ownership arbitration sits: it is the one place every operation passes
 * through holding both a session and the tab it is about.
 */

import { randomUUID } from 'node:crypto'

import type {
  BrowserActionResult,
  BrowserCaller,
  BrowserClickRequest,
  BrowserElementsRequest,
  BrowserHoverRequest,
  BrowserLoadState,
  BrowserHistoryAction,
  BrowserHost,
  BrowserPressKeyRequest,
  BrowserScreenshot,
  BrowserScrollRequest,
  BrowserSelectRequest,
  BrowserSetCheckedRequest,
  BrowserSnapshot,
  BrowserTabState,
  BrowserTextRequest,
  BrowserTypeRequest,
  BrowserWaitRequest,
} from '../../runtime/protocol/browserHost.js'
import type { WireBrowserTabInfo } from '../shellProtocol.js'
import { cdpLease, cdpSender, pageEvaluator, requirePage } from './cdp.js'
import { BrowserHostError } from './errors.js'
import { forgetRefsScript } from './inject/bundle.js'
import {
  clickTarget,
  pressKeys,
  hoverTarget,
  scrollPage,
  selectOption,
  setChecked,
  typeText,
  type InputDeps,
} from './input.js'
import { SCREENSHOT_TIMEOUT_MS } from './limits.js'
import { BrowserOwnership } from './ownership.js'
import { BrowserProjection } from './projection.js'
import type { BrowserPage, BrowserTabHost } from './tabs.js'
import { waitForCondition } from './wait.js'

/** How often a wait re-asks. Short enough to feel immediate, long enough to idle. */
const POLL_INTERVAL_MS = 100

export interface DesktopBrowserHostDeps {
  tabs: BrowserTabHost
  /**
   * The lane a session is drawn in, or `undefined` when it has none — a session
   * with no lane has no panel to show tabs in and no user watching them, which
   * is a refusal rather than a tab opened into the void.
   */
  laneForSession(sessionId: string): string | undefined
}

export class DesktopBrowserHost implements BrowserHost {
  private readonly projection = new BrowserProjection()
  private readonly ownership = new BrowserOwnership()
  /** Tabs whose refs were dropped since their last element scan; see `forgetPage`. */
  private readonly forgotten = new Set<string>()
  private readonly unsubscribe: readonly (() => void)[]

  constructor(private readonly deps: DesktopBrowserHostDeps) {
    // The tab host reports that the user touched a tab, or handed it back;
    // whether either has anyone to affect — and so whether the panel should
    // redraw — is this side's answer, because only this side knows who was
    // driving.
    this.unsubscribe = [
      deps.tabs.onTakeOver((tabId) => {
        if (this.ownership.takeOver(tabId)) this.paint([tabId], true)
      }),
      deps.tabs.onUserInput((tabId, intent) => {
        const outcome = this.ownership.userInput(tabId, intent)
        if (outcome === 'takeover') this.paint([tabId], true)
        else if (outcome === 'stale') this.forgetPage(tabId)
      }),
      deps.tabs.onRelease((tabId) => {
        this.paint(this.ownership.release(tabId))
      }),
    ]
  }

  dispose(): void {
    for (const off of this.unsubscribe) off()
  }

  /**
   * The runtime finished a session's turn. The session goes back to idle: its
   * tabs are the user's again, a takeover it was under ends, and whatever the
   * turn left running stops at its next checkpoint.
   */
  turnEnded(sessionId: string): void {
    this.paint(this.ownership.turnEnded(sessionId))
  }

  async listTabs(caller: BrowserCaller): Promise<BrowserTabState[]> {
    this.enter(caller)
    const lane = this.requireLane(caller)
    return this.deps.tabs.describe().filter((tab) => tab.lane === lane).map(toState)
  }

  async createTab(caller: BrowserCaller, url?: string): Promise<BrowserTabState> {
    this.enter(caller)
    const lane = this.requireLane(caller)
    const tabId = this.deps.tabs.createTab(lane, url)
    this.claim(tabId, caller.sessionId)
    return this.stateOf(tabId)
  }

  async closeTab(caller: BrowserCaller, tabId: string): Promise<void> {
    this.enter(caller)
    this.requireTab(caller, tabId)
    // Tearing a tab down is not a person reaching for the keyboard, but it fires
    // the same events, so the close says so for as long as it lasts.
    const done = this.ownership.expectAgentClose(tabId)
    try {
      this.deps.tabs.closeTab(tabId)
    } finally {
      done()
    }
    this.projection.dropTab(tabId)
    this.ownership.dropTab(tabId)
    this.forgotten.delete(tabId)
  }

  async navigate(caller: BrowserCaller, tabId: string, url: string): Promise<BrowserTabState> {
    this.enter(caller)
    this.requireTab(caller, tabId)
    this.deps.tabs.navigate(tabId, url)
    // Cursors are keyed on the navigation generation and would be refused
    // anyway; dropping them here just frees the bytes a turn earlier.
    this.projection.dropTab(tabId)
    return this.stateOf(tabId)
  }

  async history(caller: BrowserCaller, tabId: string, action: BrowserHistoryAction): Promise<BrowserTabState> {
    this.enter(caller)
    this.requireTab(caller, tabId)
    if (action === 'reload') {
      this.deps.tabs.reload(tabId)
    } else {
      const moved = action === 'back' ? this.deps.tabs.goBack(tabId) : this.deps.tabs.goForward(tabId)
      if (!moved) {
        throw new BrowserHostError(
          'INVALID_REQUEST',
          `This tab has no page to go ${action} to. Use tab.navigate with a URL instead.`,
        )
      }
    }
    // Same reason as `navigate`: the document is on its way out.
    this.projection.dropTab(tabId)
    return this.stateOf(tabId)
  }

  async waitForLoad(
    caller: BrowserCaller,
    tabId: string,
    options: { timeoutMs: number; until?: BrowserLoadState; signal?: AbortSignal },
  ): Promise<BrowserTabState> {
    const revision = this.enter(caller)
    const until = options.until ?? 'load'
    this.requireTab(caller, tabId)
    const check = this.guard(caller, revision, options.signal)
    // Monotonic: a clock adjustment mid-wait must not end it early or hang it.
    const deadline = performance.now() + options.timeoutMs
    for (;;) {
      check()
      const row = this.requireTab(caller, tabId)
      // `loading` is the tab's own answer about the navigation in flight, and
      // it is set synchronously by `navigate`, so a wait issued right after one
      // cannot observe the *previous* document's finished state. A tab that has
      // never navigated is not loading either — it is already as loaded as it
      // will get, and saying so beats timing out.
      if (!row.loading) {
        if (this.deps.tabs.refusedUnload(tabId)) {
          throw new BrowserHostError(
            'NAVIGATION_FAILED',
            `The page refused to be left (it may hold unsaved input), so the navigation did not happen and the tab still shows ${row.url || '(blank)'}. Ask the user before retrying.`,
          )
        }
        return toState(row)
      }
      // The DOM is parsed, and that is all a `domcontentloaded` wait asked:
      // images, fonts and iframes may still be arriving.
      if (until === 'domcontentloaded' && this.deps.tabs.pageFor(tabId)?.domReady === true) return toState(row)
      if (performance.now() > deadline) {
        throw new BrowserHostError(
          'WAIT_TIMEOUT',
          `The page did not ${until === 'load' ? 'finish loading' : 'reach DOMContentLoaded'} within ${options.timeoutMs}ms. Last seen: ${describe(row)}`,
        )
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async elements(caller: BrowserCaller, tabId: string, request: BrowserElementsRequest): Promise<BrowserSnapshot> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    const snapshot = await this.projection.elements(ownerOf(page), pageEvaluator(page), request)
    // The page has live refs again, so the next idle touch has some to forget.
    this.forgotten.delete(tabId)
    this.ownership.assertAllowed(caller.sessionId, revision)
    return snapshot
  }

  async text(caller: BrowserCaller, tabId: string, request: BrowserTextRequest): Promise<BrowserSnapshot> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    const snapshot = await this.projection.text(ownerOf(page), pageEvaluator(page), request)
    this.ownership.assertAllowed(caller.sessionId, revision)
    return snapshot
  }

  async readSnapshot(caller: BrowserCaller, tabId: string, cursor: string, maxChars?: number): Promise<BrowserSnapshot> {
    this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return this.projection.read(ownerOf(page), cursor, maxChars)
  }

  async screenshot(caller: BrowserCaller, tabId: string): Promise<BrowserScreenshot> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    // Through CDP first: `Page.captureScreenshot` asks the renderer for a fresh
    // frame, which a tab parked off the panel still produces — `capturePage()`
    // would hand back whatever the window compositor last drew instead. The
    // latter stays as the fallback for when the debugger is unavailable (DevTools
    // holds it), and there a stale-but-real frame beats no picture.
    const bytes = (await captureViaCdp(page)) ?? (await captureViaWindow(page))
    if (bytes === undefined) throw notCaptured()
    this.ownership.assertAllowed(caller.sessionId, revision)
    const { width, height } = pngSize(bytes)
    if (width === 0 || height === 0) throw notCaptured()
    return { bytes, name: screenshotName(this.rowFor(tabId)?.url ?? ''), width, height }
  }

  async click(caller: BrowserCaller, tabId: string, request: BrowserClickRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return clickTarget(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async type(caller: BrowserCaller, tabId: string, request: BrowserTypeRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return typeText(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async pressKey(caller: BrowserCaller, tabId: string, request: BrowserPressKeyRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return pressKeys(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async selectOption(caller: BrowserCaller, tabId: string, request: BrowserSelectRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return selectOption(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async setChecked(
    caller: BrowserCaller,
    tabId: string,
    request: BrowserSetCheckedRequest,
  ): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return setChecked(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async hover(caller: BrowserCaller, tabId: string, request: BrowserHoverRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return hoverTarget(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async scroll(caller: BrowserCaller, tabId: string, request: BrowserScrollRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    const page = this.requirePage(caller, tabId)
    return scrollPage(this.inputDeps(page, this.guard(caller, revision, request.signal)), request)
  }

  async waitFor(caller: BrowserCaller, tabId: string, request: BrowserWaitRequest): Promise<BrowserActionResult> {
    const revision = this.enter(caller)
    // A wait for nothing but an address is about a navigation, and a navigation
    // is exactly when there is no ready document to insist on.
    const urlOnly = (request.selector ?? '') === '' && (request.text ?? '') === ''
    if (urlOnly) this.requireTab(caller, tabId)
    else this.requirePage(caller, tabId)
    const deps = {
      // Resolved per poll, like everything below: the page a wait started on
      // is not necessarily the one it ends on.
      evaluate: (script: string) => {
        const page = this.deps.tabs.pageFor(tabId)
        if (page === undefined) {
          return Promise.reject(new BrowserHostError('PAGE_NOT_READY', 'The tab has no page right now.', true))
        }
        return pageEvaluator(page)(script)
      },
      // Re-read every poll rather than closing over `page.generation`: a
      // navigation that lands mid-wait is exactly what this has to notice.
      generation: () => this.deps.tabs.pageFor(tabId)?.generation,
      url: () => this.deps.tabs.pageFor(tabId)?.contents.getURL(),
      check: this.guard(caller, revision, request.signal),
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    return waitForCondition(deps, request)
  }

  // --- internals -------------------------------------------------------------

  /**
   * Everything `input.ts` needs, and nothing it does not.
   *
   * `page.contents` is handed over as the queue's identity rather than as an
   * object to call: actions on one tab serialize on that key, and two sessions
   * addressing the same tab land in the same queue.
   */
  private inputDeps(page: BrowserPage, check: () => void): InputDeps {
    return {
      key: page.contents,
      send: cdpSender(page),
      lease: cdpLease(page),
      evaluate: pageEvaluator(page),
      check,
      platform: process.platform,
    }
  }

  /**
   * The two questions every operation opens with: is this a new turn, and may
   * this session still drive the browser?
   *
   * A new turn lifts a takeover the user never handed back, so observing the
   * turn is also what frees the tabs it had flagged.
   */
  private enter(caller: BrowserCaller): number {
    const { revision } = this.ownership.observeTurn(caller.sessionId, caller.turnId)
    this.paint(this.ownership.tabsOf(caller.sessionId))
    this.ownership.assertAllowed(caller.sessionId, revision)
    return revision
  }

  /**
   * Draws each tab as its session's state says: the banner while the agent is
   * driving, the badge while the user holds it, neither while idle. Both setters
   * skip a value that did not change, so painting too much costs nothing.
   *
   * `takenOver` is passed by the takeover paths, which already know the answer,
   * so the badge lands in the same change as the banner leaving.
   */
  private paint(tabIds: readonly string[], takenOver?: boolean): void {
    for (const tabId of tabIds) {
      const driver = this.ownership.tabDriver(tabId)
      this.deps.tabs.setTakenOver(tabId, takenOver ?? driver === 'user')
      this.deps.tabs.setAgentActive(tabId, driver === 'agent')
    }
  }

  /**
   * The user touched a tab while its session was idle: whatever the agent last
   * read of it may no longer be true. Cursors go now; the refs live in the page,
   * so they are cleared there — a ref the model still holds then misses with
   * `STALE_ELEMENT` instead of landing on whatever took its place.
   *
   * Once per scan rather than per keystroke: the first touch already dropped
   * every ref there was.
   */
  private forgetPage(tabId: string): void {
    this.projection.dropTab(tabId)
    if (this.forgotten.has(tabId)) return
    const page = this.deps.tabs.pageFor(tabId)
    if (page === undefined) return
    this.forgotten.add(tabId)
    pageEvaluator(page)(forgetRefsScript()).catch(() => {
      // A page mid-navigation loses its automation world, refs and all.
    })
  }

  /**
   * The check an operation makes at every await boundary: cancelled, taken over,
   * or overtaken by a newer turn. One hook, because an operation should not have
   * to know which of the three stopped it — only that it must stop now.
   */
  private guard(caller: BrowserCaller, revision: number, signal?: AbortSignal): () => void {
    return () => {
      if (signal?.aborted === true) {
        throw new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
      }
      this.ownership.assertAllowed(caller.sessionId, revision)
    }
  }

  private requireLane(caller: BrowserCaller): string {
    const lane = this.deps.laneForSession(caller.sessionId)
    if (lane === undefined) {
      throw new BrowserHostError(
        'BROWSER_UNAVAILABLE',
        'The browser is not available to this session: it has no window to draw tabs in.',
      )
    }
    return lane
  }

  /** The tab's row, once this session is entitled to it. */
  private requireTab(caller: BrowserCaller, tabId: string): WireBrowserTabInfo {
    const lane = this.requireLane(caller)
    const row = this.rowFor(tabId)
    // A tab of another lane is reported as missing, not as forbidden: the lane
    // it belongs to is not this session's business to learn about.
    if (row === undefined || row.lane !== lane) {
      throw new BrowserHostError('TAB_NOT_FOUND', `No such browser tab: ${tabId}. Call browser.get_state for the list.`)
    }
    // Addressing a tab is what makes this session the one a takeover interrupts.
    this.claim(tabId, caller.sessionId)
    return row
  }

  /**
   * Records the driver, on both sides of the split: arbitration needs the
   * session, and the panel needs to know whether it is mid-turn — a tab nobody
   * is driving draws「接管」as unavailable rather than as a press that does
   * nothing.
   */
  private claim(tabId: string, sessionId: string): void {
    this.ownership.claim(tabId, sessionId)
    this.paint([tabId])
  }

  private requirePage(caller: BrowserCaller, tabId: string): BrowserPage {
    this.requireTab(caller, tabId)
    return requirePage(this.deps.tabs.pageFor(tabId), tabId)
  }

  private rowFor(tabId: string): WireBrowserTabInfo | undefined {
    return this.deps.tabs.describe().find((tab) => tab.tabId === tabId)
  }

  private stateOf(tabId: string): BrowserTabState {
    const row = this.rowFor(tabId)
    if (row === undefined) throw new BrowserHostError('TAB_NOT_FOUND', `No such browser tab: ${tabId}`)
    return toState(row)
  }
}

function toState(row: WireBrowserTabInfo): BrowserTabState {
  const state: BrowserTabState = { tabId: row.tabId, url: row.url, title: row.title, loading: row.loading }
  if (row.error !== undefined) state.error = row.error
  if (row.takenOver === true) state.takenOver = true
  if (row.blockedDownloads !== undefined) state.blockedDownloads = [...row.blockedDownloads]
  return state
}

function ownerOf(page: BrowserPage): { tabId: string; contentsId: number; generation: number } {
  return { tabId: page.tabId, contentsId: page.contentsId, generation: page.generation }
}

function describe(row: WireBrowserTabInfo): string {
  return row.error !== undefined ? `${row.url || '(blank)'} — ${row.error}` : row.url || '(blank)'
}

/**
 * A name the transcript can read back. The host is the useful half; the random
 * suffix is what keeps two screenshots of one page from colliding in the store.
 */
function screenshotName(url: string): string {
  let host = 'page'
  try {
    host = new URL(url).hostname || host
  } catch {
    // A blank or non-URL tab keeps the default.
  }
  return `screenshot-${host.replace(/[^a-zA-Z0-9.-]/g, '-')}-${randomUUID().slice(0, 8)}.png`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The one refusal every unusable capture collapses to. */
function notCaptured(): BrowserHostError {
  return new BrowserHostError(
    'PAGE_NOT_READY',
    'The page could not be captured right now. Try again, or read the page with page.text.snapshot.',
    true,
  )
}

async function captureViaCdp(page: BrowserPage): Promise<Buffer | undefined> {
  const release = cdpLease(page)()
  try {
    const result = await withTimeout(
      cdpSender(page)('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      SCREENSHOT_TIMEOUT_MS,
    )
    const data = (result as { data?: unknown } | undefined)?.data
    return typeof data === 'string' ? Buffer.from(data, 'base64') : undefined
  } catch {
    return undefined
  } finally {
    release()
  }
}

async function captureViaWindow(page: BrowserPage): Promise<Buffer | undefined> {
  if (page.contents.isDestroyed()) return undefined
  const image = await withTimeout(page.contents.capturePage(), SCREENSHOT_TIMEOUT_MS).catch(() => undefined)
  return image === undefined || image.isEmpty() ? undefined : image.toPNG()
}

/** The pixel size from a PNG's IHDR chunk, which always comes first. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The promise's value, or `undefined` if it took longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
