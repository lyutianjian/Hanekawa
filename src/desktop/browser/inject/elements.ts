/**
 * The element collector, as it runs inside the page.
 *
 * Read `semantics.ts`'s header first: the same serialization rules apply to
 * everything here, and the entry point below is called by a string the bundler
 * writes, not by any code in this process.
 *
 * Two decisions shape the whole file:
 *
 * - **Filtering happens here.** Scope, role and text narrowing cost one round
 *   trip if the main process does them and none if the page does, and the
 *   difference is the difference between shipping 2,000 rows and shipping 12.
 * - **Refs are short names over a page-side map.** `e1` costs three tokens;
 *   anything addressing a node by path or selector costs dozens and goes stale
 *   in ways nobody can see. The authority is `__hanekawaBrowserElements` in the
 *   automation world — a navigation replaces the world, so old refs die with
 *   their document instead of quietly pointing at a different one.
 */

import type { InjDocument, InjElement, InjGlobal, InjWindow } from './dom.js'
import {
  hkInteractive,
  hkName,
  hkOffscreen,
  hkProp,
  hkRole,
  hkSensitive,
  hkString,
  hkTag,
  hkText,
  hkTrim,
  hkVisible,
  hkWalk,
} from './semantics.js'

export interface ElementScanOptions {
  snapshotId: string
  /** A CSS selector for the subtree to scan. Absent means the document body. */
  scope?: string
  /** Exact role match, lower-cased by the caller. */
  role?: string
  /** Case-insensitive substring of the row's name or text. */
  text?: string
  interactiveOnly: boolean
  visibleOnly: boolean
  /** Add each visible row's viewport box. Off by default: it costs a column of numbers per row. */
  includeBounds?: boolean
  maxResults: number
  maxNodes: number
  budgetMs: number
  nameMax: number
  textMax: number
  sensitiveWords: string[]
  interactiveSelector: string
}

/** Undefined-valued keys are deleted before the row leaves the page. */
export interface ElementRow {
  ref: string
  role: string
  name?: string
  text?: string
  value?: string
  href?: string
  visible?: boolean
  /** Visible, but scrolled out of the viewport. */
  offscreen?: boolean
  disabled?: boolean
  checked?: boolean
  focused?: boolean
  required?: boolean
  /** Viewport box in CSS pixels, rounded: x, y, width, height. Only when asked for, and only if visible. */
  bounds?: [number, number, number, number]
}

export interface ElementScanResult {
  snapshotId: string
  url: string
  title: string
  rows: ElementRow[]
  /** A budget ran out. The rows missing because of it never left the renderer. */
  truncated: boolean
  scanned: number
}

export function hkFlag(el: InjElement, prop: string, aria: string): boolean {
  if (hkProp(el, prop) === true) return true
  return hkString(el.getAttribute(aria)).toLowerCase() === 'true'
}

/** The editable value of a field, or `''` for anything that has no value. */
export function hkValue(el: InjElement, max: number): string {
  const tag = hkTag(el)
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return ''
  return hkTrim(hkString(hkProp(el, 'value')), max)
}

export function hkCollectElements(
  doc: InjDocument,
  win: InjWindow,
  g: InjGlobal,
  opts: ElementScanOptions,
): ElementScanResult {
  const scope = opts.scope
  const root = scope === undefined ? doc.body ?? doc.documentElement : doc.querySelector(scope)
  if (root === null || root === undefined) {
    throw new Error('INVALID_REQUEST: no element matches scope ' + (scope === undefined ? '<body>' : scope))
  }

  const state = { nodes: 0, maxNodes: opts.maxNodes, deadline: Date.now() + opts.budgetMs, truncated: false }
  const rows: ElementRow[] = []
  const elements = new Map<string, InjElement>()
  const needle = opts.text === undefined ? '' : opts.text.toLowerCase()
  const active = doc.activeElement

  hkWalk(root, state, (el) => {
    if (rows.length >= opts.maxResults) return false
    if (opts.interactiveOnly && !hkInteractive(el, win, opts.interactiveSelector)) return true

    const visible = hkVisible(el, win)
    if (opts.visibleOnly && !visible) return true

    const role = hkRole(el)
    if (opts.role !== undefined && role !== opts.role) return true

    const sensitive = hkSensitive(el, opts.sensitiveWords)
    const name = hkName(el, doc, sensitive, opts.nameMax)
    const text = sensitive ? '' : hkText(el, opts.textMax)
    if (needle !== '' && (name + ' ' + text).toLowerCase().indexOf(needle) === -1) return true

    const ref = 'e' + (rows.length + 1)
    elements.set(ref, el)

    const row: ElementRow = { ref, role }
    if (name !== '') row.name = name
    if (text !== '') row.text = text
    if (!sensitive) {
      const value = hkValue(el, opts.textMax)
      if (value !== '') row.value = value
    }
    const href = hkString(hkProp(el, 'href'))
    if (href !== '' && role === 'link') row.href = hkTrim(href, opts.nameMax)
    if (visible) {
      row.visible = true
      // One measurement for both answers: the rect is not free on a large page.
      const rect = el.getBoundingClientRect()
      if (hkOffscreen(rect, win)) row.offscreen = true
      if (opts.includeBounds === true) {
        row.bounds = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
      }
    }
    if (hkFlag(el, 'disabled', 'aria-disabled')) row.disabled = true
    if (hkFlag(el, 'checked', 'aria-checked')) row.checked = true
    if (active === el) row.focused = true
    if (hkFlag(el, 'required', 'aria-required')) row.required = true
    rows.push(row)
    return true
  })

  // The map is replaced wholesale: one snapshot's refs are live at a time, and a
  // stale `e3` must miss rather than resolve against a newer scan's third row.
  g.__hanekawaBrowserElements = { snapshotId: opts.snapshotId, elements }

  return {
    snapshotId: opts.snapshotId,
    url: hkString(hkProp(doc as unknown as InjElement, 'URL')),
    title: typeof doc.title === 'string' ? doc.title : '',
    rows,
    truncated: state.truncated,
    scanned: state.nodes,
  }
}

/**
 * Drops the refs the last scan handed out, and the target the last resolve
 * settled on. Used when the user has been at the page between turns: whatever
 * `e3` pointed at may have been replaced, and a miss is the honest answer.
 */
export function hkForgetRefs(g: InjGlobal): boolean {
  delete g.__hanekawaBrowserElements
  delete g.__hanekawaBrowserTarget
  return true
}
