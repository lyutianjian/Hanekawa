/**
 * The page-side half of acting on a page: find a target, aim at it, scroll, and
 * answer "has this happened yet".
 *
 * Read `semantics.ts`'s header first — everything here crosses as source text
 * and lives under the same rules. What is specific to this file is the division
 * of labour with `input.ts`:
 *
 * - **The page resolves and aims; the host dispatches.** These functions never
 *   synthesize an event. They hand back viewport coordinates, and the real
 *   press/release goes through CDP from the main process, so the page sees input
 *   that is indistinguishable from the user's. A `el.click()` here would be
 *   trivially detectable and would skip hover, focus and default modifiers.
 * - **Scrolling is the exception**, because there is nothing to fake: a scroll
 *   the page performs on itself fires the same `scroll` events a wheel does, and
 *   a wheel event would have to guess the page's own scroll granularity.
 * - **A ref is checked for still being attached.** The ref map outlives the
 *   nodes in it — a re-rendered list leaves `e3` pointing at a detached element,
 *   which would otherwise accept a click nobody can see.
 */

import type { InjDocument, InjElement, InjGlobal, InjWindow } from './dom.js'
import { hkFlag } from './elements.js'
import { hkName, hkProp, hkRole, hkSensitive, hkString, hkTrim, hkVisible, hkWalk } from './semantics.js'
import { hkOwnText } from './text.js'

export interface TargetOptions {
  /** A ref from the latest `page.elements.snapshot`. Wins over `selector`. */
  ref?: string
  selector?: string
  nameMax: number
  sensitiveWords: string[]
  /** Bring it on screen before measuring. Off only for a pure inspection. */
  scrollIntoView: boolean
  /** Focus it and refuse the operation if it will not take focus. */
  focus: boolean
  /** Refuse a disabled element. Off for operations a disabled node can answer. */
  requireEnabled: boolean
}

export interface TargetResult {
  ref?: string
  selector?: string
  role: string
  name: string
  /** A password-ish field: the host must not echo what it types here. */
  sensitive: boolean
  /** Viewport coordinates of the element's centre, in CSS pixels. */
  x: number
  y: number
  width: number
  height: number
  focused: boolean
  url: string
  title: string
}

export interface ScrollOptions {
  ref?: string
  selector?: string
  direction: 'up' | 'down' | 'top' | 'bottom'
  /** Pixels for `up`/`down`. Absent means most of a viewport. */
  amount?: number
  viewportFraction: number
}

export interface ScrollResult {
  scrollY: number
  maxScrollY: number
  viewport: number
  atBottom: boolean
  /** What was scrolled: a ref, a selector, or the direction taken. */
  target: string
  url: string
  title: string
}

export interface ConditionOptions {
  /** Restricts the search, or is the condition itself when `text` is absent. */
  selector?: string
  text?: string
  state: 'visible' | 'hidden'
  maxNodes: number
  budgetMs: number
  segmentMax: number
}

export interface ConditionResult {
  matched: boolean
  /** What was actually seen, in the wait's own words. Survives a timeout. */
  observed: string
  url: string
  title: string
}

export function hkQuery(doc: InjDocument, selector: string): InjElement | null {
  try {
    return doc.querySelector(selector)
  } catch {
    throw new Error('INVALID_REQUEST: not a usable CSS selector: ' + selector)
  }
}

/** The element a request names, or the reason the request cannot be honoured. */
export function hkFindTarget(doc: InjDocument, g: InjGlobal, ref?: string, selector?: string): InjElement {
  if (ref !== undefined && ref !== '') {
    const registry = g.__hanekawaBrowserElements
    const found = registry === undefined ? undefined : registry.elements.get(ref)
    if (found === undefined) {
      throw new Error(
        'STALE_ELEMENT: ref ' + ref + ' is not on this page. Take a fresh page.elements.snapshot and use its refs.',
      )
    }
    // A ref survives its node: the map is replaced per scan, not per render.
    if (hkProp(found, 'isConnected') === false) {
      throw new Error('STALE_ELEMENT: ref ' + ref + ' was removed from the page. Take a fresh page.elements.snapshot.')
    }
    return found
  }
  if (selector === undefined || selector === '') {
    throw new Error('INVALID_REQUEST: name a ref (from page.elements.snapshot) or a selector.')
  }
  const found = hkQuery(doc, selector)
  if (found === null) throw new Error('STALE_ELEMENT: no element matches ' + selector)
  return found
}

export function hkResolveTarget(
  doc: InjDocument,
  win: InjWindow,
  g: InjGlobal,
  opts: TargetOptions,
): TargetResult {
  const el = hkFindTarget(doc, g, opts.ref, opts.selector)
  const label = opts.ref !== undefined && opts.ref !== '' ? 'ref ' + opts.ref : 'selector ' + hkString(opts.selector)

  if (opts.scrollIntoView) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      // Not every element accepts it (a detached one, an exotic polyfill); the
      // geometry check below is what actually decides whether this can proceed.
    }
  }

  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || !hkVisible(el, win)) {
    throw new Error('ELEMENT_NOT_INTERACTABLE: ' + label + ' is not visible on the page.')
  }
  if (opts.requireEnabled && hkFlag(el, 'disabled', 'aria-disabled')) {
    throw new Error('ELEMENT_NOT_INTERACTABLE: ' + label + ' is disabled.')
  }

  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) {
    throw new Error(
      'ELEMENT_NOT_INTERACTABLE: ' + label + ' could not be brought into the viewport; its centre is off screen.',
    )
  }

  if (opts.focus) {
    try {
      el.focus()
    } catch {
      // Same as above: `activeElement` is the answer, not the call.
    }
  }
  const focused = doc.activeElement === el
  if (opts.focus && !focused) {
    throw new Error('ELEMENT_NOT_INTERACTABLE: ' + label + ' did not take focus. Click it first, then type.')
  }

  const sensitive = hkSensitive(el, opts.sensitiveWords)
  const result: TargetResult = {
    role: hkRole(el),
    name: hkName(el, doc, sensitive, opts.nameMax),
    sensitive,
    x,
    y,
    width: rect.width,
    height: rect.height,
    focused,
    url: hkString(hkProp(doc as unknown as InjElement, 'URL')),
    title: typeof doc.title === 'string' ? doc.title : '',
  }
  if (opts.ref !== undefined) result.ref = opts.ref
  if (opts.selector !== undefined) result.selector = opts.selector
  return result
}

export function hkScrollPage(doc: InjDocument, win: InjWindow, g: InjGlobal, opts: ScrollOptions): ScrollResult {
  const root = doc.documentElement
  const height = root === null ? 0 : Number(hkProp(root, 'scrollHeight'))
  const maxScrollY = Math.max(0, (Number.isFinite(height) ? height : 0) - win.innerHeight)
  let target: string

  if ((opts.ref !== undefined && opts.ref !== '') || (opts.selector !== undefined && opts.selector !== '')) {
    const el = hkFindTarget(doc, g, opts.ref, opts.selector)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    target = opts.ref !== undefined && opts.ref !== '' ? 'ref ' + opts.ref : 'selector ' + hkString(opts.selector)
  } else if (opts.direction === 'top') {
    win.scrollTo(0, 0)
    target = 'top'
  } else if (opts.direction === 'bottom') {
    win.scrollTo(0, maxScrollY)
    target = 'bottom'
  } else {
    const step = opts.amount !== undefined ? opts.amount : Math.round(win.innerHeight * opts.viewportFraction)
    win.scrollBy(0, opts.direction === 'up' ? -step : step)
    target = opts.direction + ' ' + step + 'px'
  }

  const scrollY = win.scrollY
  return {
    scrollY,
    maxScrollY,
    viewport: win.innerHeight,
    atBottom: scrollY >= maxScrollY - 1,
    target,
    url: hkString(hkProp(doc as unknown as InjElement, 'URL')),
    title: typeof doc.title === 'string' ? doc.title : '',
  }
}

export function hkCheckCondition(doc: InjDocument, win: InjWindow, opts: ConditionOptions): ConditionResult {
  const url = hkString(hkProp(doc as unknown as InjElement, 'URL'))
  const title = typeof doc.title === 'string' ? doc.title : ''
  const wantVisible = opts.state === 'visible'
  const answer = (present: boolean, observed: string): ConditionResult => ({
    matched: wantVisible ? present : !present,
    observed,
    url,
    title,
  })

  const selector = opts.selector
  const root = selector === undefined || selector === '' ? doc.body ?? doc.documentElement : hkQuery(doc, selector)
  const where = selector === undefined || selector === '' ? 'the page' : selector
  if (root === null || root === undefined) {
    return answer(false, 'no element matches ' + where)
  }

  const needle = opts.text
  if (needle === undefined || needle === '') {
    const visible = hkVisible(root, win)
    return answer(visible, visible ? where + ' is visible' : where + ' is present but not visible')
  }

  // Text is matched against each element's *own* text for the reason the text
  // collector does it: a container's `textContent` matches a phrase that is
  // scattered across three unrelated children.
  const lower = needle.toLowerCase()
  const state = { nodes: 0, maxNodes: opts.maxNodes, deadline: Date.now() + opts.budgetMs, truncated: false }
  let hit = ''
  hkWalk(root, state, (el) => {
    const text = hkOwnText(el, opts.segmentMax)
    if (text === '' || text.toLowerCase().indexOf(lower) === -1) return true
    if (!hkVisible(el, win)) return true
    hit = hkTrim(text, 160)
    return false
  })

  if (hit !== '') return answer(true, 'found "' + needle + '" in: ' + hit)
  const suffix = state.truncated ? ' (the scan hit its budget before finishing)' : ''
  return answer(false, '"' + needle + '" is not visible in ' + where + suffix)
}
