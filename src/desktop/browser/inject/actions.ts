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
import { hkName, hkParent, hkProp, hkRole, hkSensitive, hkString, hkTag, hkTrim, hkVisible, hkWalk } from './semantics.js'
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
  /**
   * Refuse an element something else is drawn over at the aim point. Off for
   * typing: `focus()` does not go through the hit test, so a covered field
   * still takes its keystrokes.
   */
  requireHit?: boolean
  /**
   * A native checkbox or radio styled out of sight is operated through its
   * visible `<label>` instead, which is the element the user actually sees.
   */
  viaLabel?: boolean
}

export interface GuardOptions {
  /** `pointer` re-runs the hit test at (x, y); `keyboard` re-checks focus. */
  mode: 'pointer' | 'keyboard'
  x?: number
  y?: number
  /** How the refusal names the target: `ref e3`, `selector #q`. */
  label: string
  nameMax: number
  sensitiveWords: string[]
}

export interface TargetResult {
  ref?: string
  selector?: string
  role: string
  name: string
  /** A password-ish field: the host must not echo what it types here. */
  sensitive: boolean
  /** Viewport coordinates of the centre of the element's on-screen part, in CSS pixels. */
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

/**
 * The element a press at (x, y) lands on, through every open shadow root.
 *
 * `document.elementFromPoint` stops at a shadow host, so the answer is refined
 * one root at a time until a root has nothing deeper to say.
 */
export function hkDeepHit(doc: InjDocument, x: number, y: number): InjElement | null {
  let hit = doc.elementFromPoint(x, y)
  for (let depth = 0; hit !== null && depth < 32; depth += 1) {
    const shadow = hit.shadowRoot
    if (shadow === null || shadow === undefined || typeof shadow.elementFromPoint !== 'function') break
    const inner = shadow.elementFromPoint(x, y)
    if (inner === null || inner === undefined || inner === hit) break
    hit = inner
  }
  return hit
}

/** `node` is `el` or inside it, across shadow boundaries: an icon in a button is the button. */
export function hkContains(el: InjElement, node: InjElement | null): boolean {
  let current = node
  for (let depth = 0; current !== null && depth < 256; depth += 1) {
    if (current === el) return true
    current = hkParent(current)
  }
  return false
}

/** The focused element, drilled through open shadow roots to the innermost one. */
export function hkDeepActive(doc: InjDocument): InjElement | null {
  let active = doc.activeElement
  for (let depth = 0; active !== null && depth < 32; depth += 1) {
    const shadow = active.shadowRoot
    const inner = shadow === null || shadow === undefined ? undefined : shadow.activeElement
    if (inner === null || inner === undefined || inner === active) break
    active = inner
  }
  return active
}

/** Whatever is in the way, named well enough to dismiss: tag, role, a short name. */
export function hkDescribe(el: InjElement | null, doc: InjDocument, words: string[]): string {
  if (el === null) return 'nothing the page reports'
  const tag = hkTag(el)
  const role = hkRole(el)
  const sensitive = hkSensitive(el, words)
  const name = sensitive ? '' : hkName(el, doc, false, 80)
  let out = '<' + tag + (role !== tag ? ' role=' + role : '') + '>'
  if (name !== '') out += ' "' + name + '"'
  return out
}

export function hkResolveTarget(
  doc: InjDocument,
  win: InjWindow,
  g: InjGlobal,
  opts: TargetOptions,
): TargetResult {
  let el = hkFindTarget(doc, g, opts.ref, opts.selector)
  const label = opts.ref !== undefined && opts.ref !== '' ? 'ref ' + opts.ref : 'selector ' + hkString(opts.selector)

  if (opts.viaLabel === true && hkTag(el) === 'input') {
    const box = el.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || !hkVisible(el, win)) {
      const labels = hkProp(el, 'labels') as ArrayLike<InjElement> | null | undefined
      const first = labels === null || labels === undefined || labels.length === 0 ? undefined : labels[0]
      if (first !== undefined) {
        const labelBox = first.getBoundingClientRect()
        if (labelBox.width > 0 && labelBox.height > 0 && hkVisible(first, win)) el = first
      }
    }
  }

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

  // Aim at the middle of the part that is on screen, not of the whole box: a
  // panel taller than the viewport has its centre wherever the scroll left it.
  const left = Math.max(0, rect.left)
  const right = Math.min(win.innerWidth, rect.left + rect.width)
  const top = Math.max(0, rect.top)
  const bottom = Math.min(win.innerHeight, rect.top + rect.height)
  if (right <= left || bottom <= top) {
    throw new Error('ELEMENT_NOT_INTERACTABLE: ' + label + ' could not be brought into the viewport; it is off screen.')
  }
  const x = (left + right) / 2
  const y = (top + bottom) / 2

  if (opts.requireHit === true) {
    const hit = hkDeepHit(doc, x, y)
    if (!hkContains(el, hit)) {
      throw new Error(
        'ELEMENT_NOT_INTERACTABLE: ' +
          label +
          ' is covered by ' +
          hkDescribe(hit, doc, opts.sensitiveWords) +
          '. Dismiss or close it first, then retry.',
      )
    }
  }

  if (opts.focus) {
    try {
      el.focus()
    } catch {
      // Same as above: `activeElement` is the answer, not the call.
    }
  }
  const active = hkDeepActive(doc)
  const focused = active !== null && hkContains(el, active)
  if (opts.focus && !focused) {
    throw new Error('ELEMENT_NOT_INTERACTABLE: ' + label + ' did not take focus. Click it first, then type.')
  }

  g.__hanekawaBrowserTarget = el
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

/**
 * The last word before an input command goes out: is the element the resolve
 * settled on still the one this press or keystroke will reach?
 *
 * Between the resolve and the press there are round trips, a hover that may
 * open a menu over the target, and the page's own timers. A press that lands
 * on whatever moved in meanwhile is a click nobody asked for.
 */
export function hkGuardTarget(doc: InjDocument, g: InjGlobal, opts: GuardOptions): boolean {
  const el = g.__hanekawaBrowserTarget
  if (el === undefined || hkProp(el, 'isConnected') === false) {
    throw new Error(
      'STALE_ELEMENT: ' + opts.label + ' was removed from the page before the input was sent. Take a fresh page.elements.snapshot.',
    )
  }
  if (opts.mode === 'pointer') {
    const x = typeof opts.x === 'number' ? opts.x : 0
    const y = typeof opts.y === 'number' ? opts.y : 0
    const hit = hkDeepHit(doc, x, y)
    if (!hkContains(el, hit)) {
      throw new Error(
        'ELEMENT_NOT_INTERACTABLE: ' +
          opts.label +
          ' is no longer under the pointer; ' +
          hkDescribe(hit, doc, opts.sensitiveWords) +
          ' is. Nothing was pressed. Take a fresh page.elements.snapshot and retry.',
      )
    }
    return true
  }
  const active = hkDeepActive(doc)
  if (active === null || !hkContains(el, active)) {
    throw new Error(
      'ELEMENT_NOT_INTERACTABLE: ' +
        opts.label +
        ' lost focus to ' +
        hkDescribe(active, doc, opts.sensitiveWords) +
        '. Nothing was typed after that point.',
    )
  }
  return true
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
