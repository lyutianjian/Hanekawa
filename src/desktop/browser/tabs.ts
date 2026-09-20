/**
 * The browser's tab host: one `WebContentsView` per tab, owned by the main
 * process and positioned over a hole the renderer measures.
 *
 * This file is the *container*, not the browser UI. It knows how to make a tab
 * exist, where to put it, when it may paint, and how to tell whether the
 * document under it is still the one somebody asked a question about. The tab
 * strip and the address bar are renderer DOM; the agent-facing projection
 * (element snapshots, input, waiting) lands beside this file in later phases and
 * reads the generation counters this one maintains.
 *
 * Three rules hold the design together:
 *
 * - **A tab belongs to a lane, not to the window.** The panel only ever draws
 *   the active lane's tabs, and a lane's tabs die with it. A pane the renderer
 *   evicts from its own budget keeps its tabs: eviction is a repaint decision,
 *   and the tab lives here.
 * - **The page gets nothing.** `sandbox`, `contextIsolation`, no `nodeIntegration`
 *   and — the one that matters most — *no preload*. Site code cannot reach any
 *   Electron or Node surface, because there is none to reach. Automation will run
 *   in an isolated world instead, which is a separate world from the page's own.
 * - **Only navigation changes the document.** `generation` moves in exactly one
 *   place, `beginNavigation`, and everything that caches a projection of the page
 *   keys on it. Resizing a tab, hiding it, or reparenting it must never look like
 *   a new document.
 */

import { WebContentsView, session, type BaseWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { WireBrowserRect, WireBrowserTabInfo } from '../shellProtocol.js'
import { BrowserHostError } from './errors.js'
import { faviconDataUrl } from './favicon.js'
import { isInputActive } from './input.js'

export { BrowserHostError }

/**
 * The browser's own storage, separate from the app renderer's.
 *
 * Persistent on purpose: an agent that cannot stay logged in can only visit the
 * public web, which rules out most of what a browser is for. Separate on
 * purpose too — the app's own renderer must not share cookies with arbitrary
 * sites the model decided to open.
 */
export const BROWSER_PARTITION = 'persist:hanekawa-browser'

/** The isolated world automation runs in. The page's own scripts live in world 0. */
export const AUTOMATION_WORLD_ID = 1001

/** A new tab's bounds until the renderer has measured its hole. */
const INITIAL_RECT: WireBrowserRect = { x: 0, y: 0, width: 1280, height: 720 }

/**
 * A tab, and the four things that make it addressable over time.
 *
 * `view` is optional because a tab outlives its `WebContents`: a crashed or
 * closed renderer drops the view and leaves the row, so the panel can still show
 * what died instead of silently losing a tab.
 */
interface TabEntry {
  tabId: string
  lane: string
  view: WebContentsView | undefined
  /**
   * Bumped once per navigation, in `beginNavigation` and nowhere else. A cached
   * projection of the page (element refs, text snapshots) is only valid while
   * this is unchanged.
   */
  generation: number
  /** The three `wait_for_load` phases, reset to -1 by every navigation. */
  committedGeneration: number
  domReadyGeneration: number
  completeGeneration: number
  /** The panel asked for this tab to be on screen. At most one tab is. */
  requestedVisible: boolean
  rect: WireBrowserRect
  url: string
  title: string
  loading: boolean
  error: string | undefined
  /** The address the failure was about; `url` still holds the last committed one. */
  errorUrl: string | undefined
  /** The site's icon as a data URL, read through `favicon.ts`. */
  favicon: string | undefined
  takenOver: boolean
  /** A session has addressed this tab, so a takeover has someone to interrupt. */
  agentControlled: boolean
}

/**
 * A tab's live page, as much of it as anything outside this file may hold.
 *
 * `contentsId` is carried separately from `contents` because it is half of the
 * snapshot cache's identity triple and must survive being copied into a cache
 * key long after the `WebContents` itself is gone.
 */
export interface BrowserPage {
  readonly tabId: string
  readonly contents: WebContents
  readonly contentsId: number
  readonly generation: number
  readonly domReady: boolean
  readonly complete: boolean
}

export class BrowserTabHost {
  private readonly tabs = new Map<string, TabEntry>()
  private readonly listeners = new Set<(tabs: WireBrowserTabInfo[]) => void>()
  private readonly takeOverListeners = new Set<(tabId: string) => void>()
  private readonly releaseListeners = new Set<(tabId: string) => void>()
  private window: BaseWindow | undefined
  private changePending = false
  private disposed = false

  // --- window lifetime -------------------------------------------------------

  /**
   * Binds the host to the one window. Called from `ensureShell` once the window
   * exists; every tab created before that point is already addressable and
   * simply has nowhere to paint yet.
   */
  attachWindow(window: BaseWindow): void {
    if (this.disposed) return
    this.window = window
    for (const entry of this.tabs.values()) this.applyGeometry(entry)
  }

  /**
   * The window went away. Views are destroyed rather than parked: a
   * `WebContentsView` whose parent is gone has nothing to attach to, and keeping
   * one alive would be a renderer process pinned by nothing on screen.
   */
  detachWindow(): void {
    this.window = undefined
    for (const entry of this.tabs.values()) this.destroyView(entry)
  }

  // --- tabs ------------------------------------------------------------------

  createTab(lane: string, url?: string): string {
    if (this.disposed) throw new BrowserHostError('BROWSER_UNAVAILABLE', 'The browser is shut down.')
    const entry: TabEntry = {
      tabId: randomUUID(),
      lane,
      view: undefined,
      generation: 0,
      committedGeneration: -1,
      domReadyGeneration: -1,
      completeGeneration: -1,
      requestedVisible: false,
      rect: INITIAL_RECT,
      url: '',
      title: '',
      loading: false,
      error: undefined,
      errorUrl: undefined,
      favicon: undefined,
      takenOver: false,
      agentControlled: false,
    }
    this.tabs.set(entry.tabId, entry)
    // The view is built eagerly rather than on first paint: a tab the agent
    // created and navigated must start loading immediately, whether or not the
    // panel is open to show it.
    this.ensureView(entry)
    if (url !== undefined) this.navigate(entry.tabId, url)
    else this.emitChange()
    return entry.tabId
  }

  closeTab(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry === undefined) return
    this.tabs.delete(tabId)
    this.destroyView(entry)
    this.emitChange()
  }

  /** Every tab of a lane that is going away. The one call `detachLane` makes. */
  closeLane(lane: string): void {
    let changed = false
    for (const entry of [...this.tabs.values()]) {
      if (entry.lane !== lane) continue
      this.tabs.delete(entry.tabId)
      this.destroyView(entry)
      changed = true
    }
    if (changed) this.emitChange()
  }

  navigate(tabId: string, url: string): void {
    const entry = this.require(tabId)
    const target = assertNavigable(url)
    const view = this.ensureView(entry)
    this.beginNavigation(entry)
    this.emitChange()
    // `loadURL` rejects on a failed navigation *and* reports the same failure
    // through `did-fail-load`. The event is the one that carries the tab's row,
    // so the rejection is swallowed rather than becoming an unhandled rejection
    // that says nothing the panel has not already been told.
    void view.webContents.loadURL(target).catch(() => {})
  }

  goBack(tabId: string): void {
    const contents = this.liveContents(tabId)
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  goForward(tabId: string): void {
    const contents = this.liveContents(tabId)
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  }

  reload(tabId: string): void {
    this.liveContents(tabId).reload()
  }

  /**
   * The user took this tab back — from the panel's button, or by touching the
   * page itself.
   *
   * It only *reports*. Whether a takeover has anyone to block, and therefore
   * whether the tab should be drawn as taken over, is `ownership.ts`'s answer,
   * and it comes back through `setTakenOver`. A tab no session has driven is not
   * a tab anyone is being taken away from.
   */
  takeOver(tabId: string): void {
    const entry = this.require(tabId)
    for (const listener of [...this.takeOverListeners]) listener(entry.tabId)
  }

  /**
   * The user handed the tab back — from 「交还」, or by sending the agent a
   * message.
   *
   * It only *reports*, for the same reason `takeOver` does: who was driving,
   * and therefore whose block this lifts, is `ownership.ts`'s answer, and it
   * comes back through `setTakenOver`.
   */
  releaseTab(tabId: string): void {
    const entry = this.require(tabId)
    for (const listener of [...this.releaseListeners]) listener(entry.tabId)
  }

  /** The flag the panel draws. Set once arbitration agrees, cleared on release. */
  setTakenOver(tabId: string, takenOver: boolean): void {
    const entry = this.tabs.get(tabId)
    if (entry === undefined || entry.takenOver === takenOver) return
    entry.takenOver = takenOver
    this.emitChange()
  }

  /**
   * A session claimed this tab. Sticky for the tab's life: a session that has
   * driven a tab once is the one a takeover interrupts until the tab closes,
   * and the panel draws its control as available on that basis.
   */
  setAgentControlled(tabId: string): void {
    const entry = this.tabs.get(tabId)
    if (entry === undefined || entry.agentControlled) return
    entry.agentControlled = true
    this.emitChange()
  }

  onTakeOver(listener: (tabId: string) => void): () => void {
    this.takeOverListeners.add(listener)
    return () => {
      this.takeOverListeners.delete(listener)
    }
  }

  onRelease(listener: (tabId: string) => void): () => void {
    this.releaseListeners.add(listener)
    return () => {
      this.releaseListeners.delete(listener)
    }
  }

  // --- geometry --------------------------------------------------------------

  /**
   * Where the hole is and whether the view may paint.
   *
   * Showing one tab hides every other: the panel draws a single tab at a time,
   * and two visible views would stack over the same hole with the older one
   * winning wherever it happened to be laid out.
   */
  setBounds(tabId: string, rect: WireBrowserRect, visible: boolean): void {
    const entry = this.tabs.get(tabId)
    // A geometry push for a tab that has just closed is not an error — the
    // renderer's `ResizeObserver` and the close can race, and the push loses.
    if (entry === undefined) return
    entry.rect = rect
    entry.requestedVisible = visible
    if (visible) {
      for (const other of this.tabs.values()) {
        if (other === entry || !other.requestedVisible) continue
        other.requestedVisible = false
        this.applyGeometry(other)
      }
    }
    this.applyGeometry(entry)
  }

  // --- projection ------------------------------------------------------------

  describe(): WireBrowserTabInfo[] {
    return [...this.tabs.values()].map((entry) => {
      const contents = entry.view?.webContents
      const live = contents !== undefined && !contents.isDestroyed()
      const info: WireBrowserTabInfo = {
        tabId: entry.tabId,
        lane: entry.lane,
        url: entry.url,
        title: entry.title,
        loading: entry.loading,
        canGoBack: live ? contents.navigationHistory.canGoBack() : false,
        canGoForward: live ? contents.navigationHistory.canGoForward() : false,
      }
      if (entry.error !== undefined) info.error = entry.error
      if (entry.errorUrl !== undefined) info.errorUrl = entry.errorUrl
      if (entry.favicon !== undefined) info.favicon = entry.favicon
      if (entry.takenOver) info.takenOver = true
      if (entry.agentControlled) info.agentControlled = true
      return info
    })
  }

  /**
   * The page behind a tab, for the projection layer.
   *
   * Deliberately narrow: the snapshot cache needs exactly the three things that
   * identify *which document* an answer was about — the tab, the renderer that
   * produced it, and the navigation it belonged to — plus a handle to ask the
   * page a question. Handing out the whole `TabEntry` would let a caller write
   * `generation`, and the one rule this file exists to keep is that only
   * navigation moves it.
   *
   * Returns `undefined` for a tab with no live renderer rather than throwing:
   * "the tab is gone" and "the tab is not ready" are different answers upstream,
   * and only the caller knows which one its operation should give.
   */
  pageFor(tabId: string): BrowserPage | undefined {
    const entry = this.tabs.get(tabId)
    const contents = entry?.view?.webContents
    if (entry === undefined || contents === undefined || contents.isDestroyed()) return undefined
    return {
      tabId: entry.tabId,
      contents,
      contentsId: contents.id,
      generation: entry.generation,
      domReady: entry.domReadyGeneration === entry.generation,
      complete: entry.completeGeneration === entry.generation,
    }
  }

  /**
   * Whether the compositor is drawing this tab right now.
   *
   * `capturePage()` only answers honestly for a view that is on screen. With the
   * panel closed it hands back the frame it painted last — byte-identical to the
   * visible capture, with no hint that it is stale — and with the window hidden
   * it never settles at all. Neither is a picture worth attaching, so the
   * screenshot path asks this first instead of trusting the image it gets.
   */
  isDisplayed(tabId: string): boolean {
    const entry = this.tabs.get(tabId)
    if (entry === undefined || entry.view === undefined || !entry.requestedVisible) return false
    const window = this.window
    return window !== undefined && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  }

  onChanged(listener: (tabs: WireBrowserTabInfo[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.tabs.values()) this.destroyView(entry)
    this.tabs.clear()
    this.listeners.clear()
    this.takeOverListeners.clear()
    this.releaseListeners.clear()
    this.window = undefined
  }

  // --- internals -------------------------------------------------------------

  private require(tabId: string): TabEntry {
    const entry = this.tabs.get(tabId)
    if (entry === undefined) throw new BrowserHostError('TAB_NOT_FOUND', `No such browser tab: ${tabId}`)
    return entry
  }

  private liveContents(tabId: string): WebContents {
    const entry = this.require(tabId)
    const contents = this.ensureView(entry).webContents
    if (contents.isDestroyed()) {
      throw new BrowserHostError('PAGE_NOT_READY', 'The browser page is unavailable.')
    }
    return contents
  }

  /**
   * A navigation started. The only place `generation` moves.
   *
   * The three load phases go back to -1 together: they are answers about *this*
   * document, and carrying one across a navigation is how a `wait_for_load`
   * resolves against the page it was supposed to be replacing.
   */
  private beginNavigation(entry: TabEntry): void {
    entry.generation += 1
    entry.committedGeneration = -1
    entry.domReadyGeneration = -1
    entry.completeGeneration = -1
    entry.loading = true
    entry.error = undefined
    entry.errorUrl = undefined
    // The icon belongs to the document that is leaving. Kept across a
    // navigation it would label the new page with the old site's mark for as
    // long as the load takes — and forever, on a page that declares none.
    entry.favicon = undefined
  }

  private ensureView(entry: TabEntry): WebContentsView {
    const existing = entry.view
    if (existing !== undefined && !existing.webContents.isDestroyed()) return existing

    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(BROWSER_PARTITION),
        // No `preload`. The three flags below are the usual hardening; the
        // absent fourth line is the one that actually keeps the automation
        // surface out of reach of the page.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden tab must keep running: the agent reads and drives tabs the
        // panel is not showing, and a throttled timer would make those pages
        // behave differently from the one on screen.
        backgroundThrottling: false,
      },
    })
    entry.view = view
    this.wire(entry, view.webContents)
    this.applyGeometry(entry)
    return view
  }

  private wire(entry: TabEntry, contents: WebContents): void {
    const alive = (): boolean => this.tabs.get(entry.tabId) === entry

    // Permission requests are denied outright in this phase. A prompt queue is
    // its own piece of work, and the honest interim behaviour is refusal: a
    // silent grant would hand a model-chosen site the camera.
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })

    // A popup becomes a tab in the same lane rather than a window. `deny` is not
    // "block the link" — it is "do not let Chromium make a window", and the tab
    // below is where the link actually goes.
    contents.setWindowOpenHandler(({ url }) => {
      if (alive() && isNavigable(url)) this.createTab(entry.lane, url)
      return { action: 'deny' }
    })

    // The person reached into the page. `input-event` sees everything the view
    // receives, including what CDP dispatches, so the guard is what tells the
    // two apart: a keystroke that arrives while the agent is mid-burst is the
    // echo of our own typing, and treating it as a takeover would abort every
    // automation sequence halfway through. Only the three kinds that mean
    // intent count — a mouse merely crossing the page does not.
    contents.on('input-event', (_event, input) => {
      if (!alive() || isInputActive(contents)) return
      if (input.type !== 'keyDown' && input.type !== 'mouseDown' && input.type !== 'mouseWheel') return
      this.takeOver(entry.tabId)
    })

    contents.on('will-navigate', (event, url) => {
      if (!isNavigable(url)) event.preventDefault()
    })

    contents.on('did-start-navigation', (details) => {
      // In-page navigations (a hash change, a `pushState`) keep the document, so
      // they must not invalidate anything keyed on `generation`.
      if (!details.isMainFrame || details.isSameDocument) return
      if (!alive()) return
      this.beginNavigation(entry)
      this.emitChange()
    })

    contents.on('did-navigate', (_event, url) => {
      if (!alive()) return
      entry.url = url
      entry.committedGeneration = entry.generation
      this.emitChange()
    })

    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!alive() || !isMainFrame) return
      entry.url = url
      this.emitChange()
    })

    contents.on('dom-ready', () => {
      if (alive()) entry.domReadyGeneration = entry.generation
    })

    contents.on('did-finish-load', () => {
      if (!alive()) return
      entry.completeGeneration = entry.generation
      entry.loading = false
      this.emitChange()
    })

    contents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
      // A cancelled navigation (-3) is what every redirect and every
      // user-interrupted load reports; it is not a failure worth showing.
      if (!alive() || !isMainFrame || errorCode === -3) return
      entry.error = errorDescription
      // The address that failed. `entry.url` is not it: nothing committed, so
      // that still names the page the tab was showing before this attempt — and
      // the panel's error page and its 「重试」 are both about this one.
      entry.errorUrl = url
      entry.loading = false
      this.emitChange()
    })

    // Fetched rather than linked: see `favicon.ts`. The generation guard is what
    // keeps a slow icon from labelling whatever the tab navigated to meanwhile.
    contents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons[0]
      if (!alive() || source === undefined) return
      const generation = entry.generation
      void faviconDataUrl(contents.session, source).then((encoded) => {
        if (!alive() || entry.generation !== generation || encoded === undefined) return
        entry.favicon = encoded
        this.emitChange()
      })
    })

    contents.on('page-title-updated', (_event, title) => {
      if (!alive()) return
      entry.title = title
      this.emitChange()
    })

    contents.on('did-stop-loading', () => {
      if (!alive() || !entry.loading) return
      entry.loading = false
      this.emitChange()
    })

    // The page's renderer died. The row survives with its last known title so
    // the user can see *which* tab crashed and reload it.
    contents.on('render-process-gone', () => {
      if (!alive()) return
      entry.loading = false
      entry.error = '页面进程已退出'
      entry.errorUrl = entry.url
      this.emitChange()
    })

    contents.on('destroyed', () => {
      if (alive() && entry.view?.webContents === contents) entry.view = undefined
    })
  }

  /**
   * One function for all three of "is it parented", "where is it" and "may it
   * paint", because they are one decision and splitting them is how a view ends
   * up attached but unpositioned, or positioned but still painting over a panel
   * that closed.
   */
  private applyGeometry(entry: TabEntry): void {
    const window = this.window
    const view = entry.view
    if (view === undefined) return
    if (window === undefined || window.isDestroyed()) return

    if (!entry.requestedVisible) {
      view.setVisible(false)
      window.contentView.removeChildView(view)
      return
    }

    // `setBounds` takes device-independent pixels, which are CSS pixels at the
    // window's default zoom — the same units the renderer measured the hole in.
    view.setBounds({
      x: Math.round(entry.rect.x),
      y: Math.round(entry.rect.y),
      width: Math.max(0, Math.round(entry.rect.width)),
      height: Math.max(0, Math.round(entry.rect.height)),
    })
    // `addChildView` on a view that is already a child reorders it to the top,
    // which is what keeps the page above anything added before it.
    window.contentView.addChildView(view)
    view.setVisible(true)
  }

  private destroyView(entry: TabEntry): void {
    const view = entry.view
    entry.view = undefined
    if (view === undefined) return
    const window = this.window
    if (window !== undefined && !window.isDestroyed()) {
      view.setVisible(false)
      window.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /**
   * Announces the tab list, coalesced to one call per microtask.
   *
   * A single page load fires `did-start-navigation`, `did-navigate`,
   * `page-title-updated`, `did-finish-load` and `did-stop-loading` in a burst,
   * and every one of them changes a field the panel draws. Sending five
   * whole-list events for one load would make the tab strip the most repainted
   * thing in the window.
   */
  private emitChange(): void {
    if (this.changePending || this.disposed) return
    this.changePending = true
    queueMicrotask(() => {
      this.changePending = false
      if (this.disposed) return
      const tabs = this.describe()
      for (const listener of [...this.listeners]) listener(tabs)
    })
  }
}

function isNavigable(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * `http:`/`https:` only.
 *
 * `file:` is the one worth refusing by name: this partition is the agent's
 * browsing context, and a `file://` document there would read the user's disk
 * with a page's privileges and ship it to whatever the page talks to.
 */
function assertNavigable(url: string): string {
  if (!isNavigable(url)) {
    throw new BrowserHostError('INVALID_REQUEST', `Only http and https URLs can be opened: ${url}`)
  }
  return url
}
