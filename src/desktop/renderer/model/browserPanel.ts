/**
 * The browser panel's decisions, as data.
 *
 * Everything here is pure: which of the window's tabs belong to the lane on
 * screen, which one of those is active, whether the native view should be
 * painting at all, and what a typed address bar means. The view
 * (`dom/browserPanelView.ts`) turns these answers into nodes and geometry
 * pushes; it makes none of them itself.
 *
 * DOM-free like the rest of `model/` — these functions are compiled into the
 * base tsconfig program by their tests, which has no DOM lib.
 */

import type { WireBrowserTabInfo } from '../../shellProtocol.js'

// --- the panel's width --------------------------------------------------------
//
// Stored and clamped exactly the way `model/sidebarWidth.ts` stores the rail's,
// because it is the same kind of thing: a local view preference that never rides
// the wire and never enters project state.

export const BROWSER_WIDTH_STORAGE_KEY = 'hanekawa.browserPanelWidth'

/**
 * The resting width, and the stylesheet's own fallback.
 *
 * 408 rather than the 480 this started at: at the window's own minimum the
 * panel has to leave a transcript worth reading beside it, and most sites hold
 * their desktop layout this far down. Below roughly here they flip to a tablet
 * breakpoint and the panel stops showing what the user is actually building —
 * which is what `BROWSER_WIDTH_MIN` marks.
 */
export const BROWSER_WIDTH_DEFAULT = 408
/** Under this the address bar cannot show a host *and* its controls. */
export const BROWSER_WIDTH_MIN = 360
/**
 * The wide end. Past this the transcript, not the browser, is the cramped
 * column — the same reasoning `SIDEBAR_WIDTH_MAX` uses, from the other side.
 */
export const BROWSER_WIDTH_MAX = 900

/** The CSS custom property the panel rule reads. Spelled once, imported by `app.ts`. */
export const BROWSER_WIDTH_VARIABLE = '--browser-panel-width'

export function clampBrowserWidth(px: number): number {
  // Non-finite is not clamped to an edge: `NaN` means the caller has no width at
  // all, and the default is the honest answer rather than the minimum.
  if (!Number.isFinite(px)) return BROWSER_WIDTH_DEFAULT
  return Math.round(Math.min(BROWSER_WIDTH_MAX, Math.max(BROWSER_WIDTH_MIN, px)))
}

/** A stored width, or the default. Takes the raw `localStorage` string, `null` included. */
export function parseBrowserWidth(raw: string | null): number {
  if (raw === null) return BROWSER_WIDTH_DEFAULT
  return clampBrowserWidth(Number.parseFloat(raw))
}

export function browserWidthVariable(px: number): string {
  return `${clampBrowserWidth(px)}px`
}

// --- which tabs, and which one --------------------------------------------------

/**
 * The tabs belonging to one lane, in the order the host announced them (which is
 * the order they were opened).
 *
 * A lane of `undefined` has no tabs rather than all of them: before the first
 * `activate` event there is no active pane, and answering with every lane's tabs
 * would draw another session's browser.
 */
export function tabsForLane(
  tabs: readonly WireBrowserTabInfo[],
  lane: string | undefined,
): readonly WireBrowserTabInfo[] {
  if (lane === undefined) return []
  return tabs.filter((tab) => tab.lane === lane)
}

/**
 * The tab to draw, given what the user last picked.
 *
 * `preferred` wins when it still exists in this lane; otherwise the last tab
 * does, which is what makes "close the active tab" land on its neighbour instead
 * of on nothing. Returns `undefined` only when the lane genuinely has no tabs.
 */
export function resolveActiveTab(
  tabs: readonly WireBrowserTabInfo[],
  lane: string | undefined,
  preferred: string | undefined,
): string | undefined {
  const own = tabsForLane(tabs, lane)
  if (own.length === 0) return undefined
  if (preferred !== undefined && own.some((tab) => tab.tabId === preferred)) return preferred
  return own[own.length - 1]!.tabId
}

/**
 * Whether the native view should be on screen.
 *
 * Four conditions, and the last two are the ones that are easy to forget: a
 * `WebContentsView` is not part of the document, so nothing the stylesheet does
 * — another panel covering the hole, the window being hidden behind another
 * app — stops it painting. It has to be told.
 */
export function shouldShowBrowserView(input: {
  /** The user opened the panel (or the agent opened a tab, which opens it). */
  open: boolean
  /** There is a tab to draw for the active lane. */
  hasActiveTab: boolean
  /** Something in the document covers the hole — the settings screen, a modal. */
  occluded: boolean
  /** `document.visibilityState === 'hidden'`. */
  windowHidden: boolean
}): boolean {
  return input.open && input.hasActiveTab && !input.occluded && !input.windowHidden
}

// --- the address bar -------------------------------------------------------------

/**
 * What a typed address means, or `undefined` when it means nothing.
 *
 * Three rules, in order:
 * - A bare `host/path` gets `https://`, because a browser address bar that
 *   demanded a scheme would be the only one in existence.
 * - Only `http:` and `https:` survive. `file:` is the one worth naming: the
 *   panel's partition is the agent's browsing context, and a `file://` tab there
 *   would read the user's disk with the page's own privileges.
 * - Anything that still will not parse is not an address.
 *
 * Deliberately *not* a search fallback: a typo would otherwise silently leave
 * the user's words with a search engine.
 */
export function normalizeAddress(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  // A host is what makes this an address rather than a scheme with a path.
  if (parsed.hostname === '') return undefined
  return parsed.href
}

/**
 * What the address bar shows when it does not have focus.
 *
 * The host alone, not the full URL: the panel is narrow, and the host is the
 * part that answers "what am I looking at". A tab that has never navigated shows
 * nothing rather than `about:blank`, so the field reads as empty and ready.
 */
export function addressLabel(tab: WireBrowserTabInfo | undefined): string {
  if (tab === undefined || tab.url === '') return ''
  try {
    return new URL(tab.url).host
  } catch {
    return tab.url
  }
}

/**
 * A tab's label in the strip.
 *
 * The title once there is one, the host until then, and a placeholder for a tab
 * that has never navigated — a strip of identical `about:blank` rows would be
 * unusable, and this is the one moment where the tab has nothing to say for
 * itself.
 */
export function tabLabel(tab: WireBrowserTabInfo): string {
  if (tab.title !== '') return tab.title
  const host = addressLabel(tab)
  return host === '' ? '新标签页' : host
}
