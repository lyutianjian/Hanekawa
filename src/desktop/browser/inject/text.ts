/**
 * The text collector: the page as prose, for reading rather than acting.
 *
 * Same serialization rules as `semantics.ts`. The element collector answers
 * "what can I click"; this one answers "what does it say", and the two are
 * separate calls because a page where both matter would otherwise pay for the
 * one it does not need.
 *
 * Text is gathered per *owning element* rather than per text node, so a sentence
 * broken across three `<span>`s comes back as one segment instead of three
 * fragments a reader has to reassemble.
 */

import type { InjDocument, InjElement, InjWindow } from './dom.js'
import { hkProp, hkString, hkTrim, hkVisible, hkWalk } from './semantics.js'

export interface TextScanOptions {
  scope?: string
  visibleOnly: boolean
  maxResults: number
  maxNodes: number
  budgetMs: number
  segmentMax: number
}

export interface TextScanResult {
  url: string
  title: string
  segments: string[]
  truncated: boolean
  scanned: number
}

/** The element's own text: its direct text-node children, nothing nested. */
export function hkOwnText(el: InjElement, max: number): string {
  let joined = ''
  const kids = el.childNodes
  for (let i = 0; i < kids.length; i += 1) {
    const node = kids[i]
    if (node === undefined || node.nodeType !== 3) continue
    joined += ' ' + (node.textContent === null ? '' : node.textContent)
  }
  return hkTrim(joined, max)
}

export function hkCollectText(doc: InjDocument, win: InjWindow, opts: TextScanOptions): TextScanResult {
  const scope = opts.scope
  const root = scope === undefined ? doc.body ?? doc.documentElement : doc.querySelector(scope)
  if (root === null || root === undefined) {
    throw new Error('INVALID_REQUEST: no element matches scope ' + (scope === undefined ? '<body>' : scope))
  }

  const state = { nodes: 0, maxNodes: opts.maxNodes, deadline: Date.now() + opts.budgetMs, truncated: false }
  const segments: string[] = []

  hkWalk(root, state, (el) => {
    if (segments.length >= opts.maxResults) return false
    const text = hkOwnText(el, opts.segmentMax)
    if (text === '') return true
    // Visibility is checked only once there is something to lose by checking it:
    // `getComputedStyle` is the expensive call in this walk, and most elements
    // have no direct text at all.
    if (opts.visibleOnly && !hkVisible(el, win)) return true
    segments.push(text)
    return true
  })

  return {
    url: hkString(hkProp(doc as unknown as InjElement, 'URL')),
    title: typeof doc.title === 'string' ? doc.title : '',
    segments,
    truncated: state.truncated,
    scanned: state.nodes,
  }
}
