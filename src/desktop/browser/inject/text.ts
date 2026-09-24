/**
 * The text collector: the page as prose, for reading rather than acting.
 *
 * Same serialization rules as `semantics.ts`. The element collector answers
 * "what can I click"; this one answers "what does it say", and the two are
 * separate calls because a page where both matter would otherwise pay for the
 * one it does not need.
 *
 * The walk is over *nodes*, not elements, and text is grouped by the block it
 * sits in. `<p>Click <a>here</a> to go on</p>` is one line, in reading order —
 * gathering each element's own text instead splits it into "Click to go on"
 * and "here", in the wrong order. A block is the nearest table row, list item
 * or heading, else the nearest paragraph-like container; each row says which
 * of those it was, so a reader can tell a heading from the prose under it.
 *
 * The walk follows the rendered tree: a shadow host contributes its shadow
 * root and not its light children, which reach the page only through the
 * `<slot>` they are assigned to — walking both would print them twice.
 */

import type { InjDocument, InjElement, InjNode, InjWindow } from './dom.js'
import { hkParent, hkProp, hkSensitive, hkString, hkTag, hkVisible } from './semantics.js'

export interface TextScanOptions {
  scope?: string
  visibleOnly: boolean
  maxResults: number
  maxNodes: number
  budgetMs: number
  /** Longest row. A longer block is split across rows, never cut short. */
  segmentMax: number
  sensitiveWords: string[]
}

/**
 * One row of the page's text.
 *
 * `kind` is `row`, `item`, `heading` or `text`; a block too long for one row
 * continues on the next with the same kind and a `+` (`text+`).
 */
export interface TextBlock {
  kind: string
  text: string
}

export interface TextScanResult {
  url: string
  title: string
  blocks: TextBlock[]
  truncated: boolean
  scanned: number
}

export interface TextBlockOptions {
  visibleOnly: boolean
  /** Stop once this many blocks are complete. */
  maxBlocks: number
  /** Characters kept per block; the scan is truncated past it. */
  maxBlockChars: number
  sensitiveWords: string[]
}

/**
 * The block a text node belongs to: nearest `tr`/`li`/`h1–6` wins, else the
 * first paragraph-like container on the way up, else the scan root.
 *
 * The climb uses the rendered parents the walk recorded (`flat`), so slotted
 * content belongs to the block around its `<slot>`, not to the host it was
 * written under.
 */
export function hkBlockOf(
  parent: InjElement,
  root: InjElement,
  flat: Map<InjElement, InjElement>,
): { el: InjElement; kind: string } {
  const containers = [
    'p', 'pre', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'div', 'section', 'article',
  ]
  let fallback: InjElement | null = null
  let node: InjElement | null = parent
  for (let depth = 0; node !== null && depth < 256; depth += 1) {
    const tag = hkTag(node)
    if (tag === 'tr') return { el: node, kind: 'row' }
    if (tag === 'li') return { el: node, kind: 'item' }
    if (/^h[1-6]$/.test(tag)) return { el: node, kind: 'heading' }
    if (fallback === null && containers.indexOf(tag) !== -1) fallback = node
    if (node === root) break
    const up: InjElement | undefined = flat.get(node)
    node = up !== undefined ? up : hkParent(node)
  }
  return { el: fallback === null ? root : fallback, kind: 'text' }
}

/**
 * The text under `root`, as blocks in reading order.
 *
 * Whitespace is collapsed per block at the end, not per node, so the space in
 * `"Order "` before `<b>confirmed</b>` survives. Between two nodes with
 * different parents a space is added when either parent lays out as a block —
 * `<span>a</span><span>b</span>` stays "ab" the way a browser draws it, while
 * two `<div>`s in one list item do not run together. The block element itself
 * counts as inline here: its text continues around its inline children.
 *
 * Visibility and display are cached per parent: `hkVisible` walks every
 * ancestor, and asking it once per text node is quadratic on a deep page.
 */
export function hkTextBlocks(
  root: InjElement,
  win: InjWindow,
  state: { nodes: number; maxNodes: number; deadline: number; truncated: boolean },
  opts: TextBlockOptions,
): TextBlock[] {
  const skip = [
    'script', 'style', 'noscript', 'template', 'head', 'input', 'textarea', 'select', 'option',
  ]
  const blocks: Array<{ el: InjElement; kind: string; text: string }> = []
  const visible = new Map<InjElement, boolean>()
  const inline = new Map<InjElement, boolean>()
  const blockCache = new Map<InjElement, { el: InjElement; kind: string }>()
  const flat = new Map<InjElement, InjElement>()
  let current: { el: InjElement; kind: string; text: string } | null = null
  let lastParent: InjElement | null = null

  const isInline = (el: InjElement, block: InjElement): boolean => {
    if (el === block) return true
    let known = inline.get(el)
    if (known === undefined) {
      const display = win.getComputedStyle(el).display
      known = typeof display === 'string' && (display.indexOf('inline') === 0 || display === 'contents')
      inline.set(el, known)
    }
    return known
  }

  // Each entry carries the element it was reached from, which is its parent in
  // the rendered tree: a host for its shadow root's nodes, a slot for what is
  // assigned to it.
  const stack: Array<{ node: InjNode; from: InjElement | null }> = [{ node: root, from: null }]
  while (stack.length > 0) {
    if (state.nodes >= state.maxNodes || Date.now() >= state.deadline) {
      state.truncated = true
      break
    }
    const entry = stack.pop() as { node: InjNode; from: InjElement | null }
    const node = entry.node
    state.nodes += 1

    if (node.nodeType === 3) {
      const raw = node.textContent === null ? '' : node.textContent
      if (raw === '') continue
      if (raw.trim() === '') {
        if (current !== null) current.text += ' '
        continue
      }
      const parent = entry.from
      if (parent === null) continue
      if (opts.visibleOnly) {
        let seen = visible.get(parent)
        if (seen === undefined) {
          seen = hkVisible(parent, win)
          visible.set(parent, seen)
        }
        if (!seen) continue
      }
      let block = blockCache.get(parent)
      if (block === undefined) {
        block = hkBlockOf(parent, root, flat)
        blockCache.set(parent, block)
      }
      if (current !== null && current.el === block.el) {
        if (current.text.length >= opts.maxBlockChars) {
          state.truncated = true
          continue
        }
        if (lastParent !== null && lastParent !== parent) {
          if (!isInline(parent, block.el) || !isInline(lastParent, block.el)) current.text += ' '
        }
        current.text += raw
      } else {
        if (blocks.length >= opts.maxBlocks) {
          state.truncated = true
          break
        }
        current = { el: block.el, kind: block.kind, text: raw }
        blocks.push(current)
      }
      lastParent = parent
      continue
    }

    if (node.nodeType !== 1) continue
    const el = node as InjElement
    if (entry.from !== null) flat.set(el, entry.from)
    const tag = hkTag(el)
    if (skip.indexOf(tag) !== -1) continue
    if (hkSensitive(el, opts.sensitiveWords)) continue
    if (tag === 'br') {
      if (current !== null) current.text += ' '
      continue
    }

    let kids: ArrayLike<InjNode> = el.childNodes
    const shadow = el.shadowRoot
    if (shadow !== null && shadow !== undefined) {
      kids = shadow.childNodes
    } else if (tag === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true })
      if (assigned.length > 0) kids = assigned
    }
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i]
      if (kid !== undefined) stack.push({ node: kid, from: el })
    }
  }

  const out: TextBlock[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i] as { kind: string; text: string }
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (text !== '') out.push({ kind: block.kind, text })
  }
  return out
}

export function hkCollectText(doc: InjDocument, win: InjWindow, opts: TextScanOptions): TextScanResult {
  const scope = opts.scope
  const root = scope === undefined ? doc.body ?? doc.documentElement : doc.querySelector(scope)
  if (root === null || root === undefined) {
    throw new Error('INVALID_REQUEST: no element matches scope ' + (scope === undefined ? '<body>' : scope))
  }

  const state = { nodes: 0, maxNodes: opts.maxNodes, deadline: Date.now() + opts.budgetMs, truncated: false }
  const whole = hkTextBlocks(root, win, state, {
    visibleOnly: opts.visibleOnly,
    maxBlocks: opts.maxResults,
    maxBlockChars: opts.segmentMax * opts.maxResults,
    sensitiveWords: opts.sensitiveWords,
  })

  // A long block becomes several rows rather than one cut short. The cut backs
  // off a high surrogate so an emoji is never split into two halves of nothing.
  const blocks: TextBlock[] = []
  const size = Math.max(2, opts.segmentMax)
  for (let i = 0; i < whole.length; i += 1) {
    const block = whole[i] as TextBlock
    let start = 0
    let first = true
    while (start < block.text.length) {
      if (blocks.length >= opts.maxResults) {
        state.truncated = true
        break
      }
      let end = Math.min(block.text.length, start + size)
      if (end < block.text.length) {
        const code = block.text.charCodeAt(end - 1)
        if (code >= 0xd800 && code <= 0xdbff) end -= 1
      }
      blocks.push({ kind: first ? block.kind : block.kind + '+', text: block.text.slice(start, end) })
      start = end
      first = false
    }
  }

  return {
    url: hkString(hkProp(doc as unknown as InjElement, 'URL')),
    title: typeof doc.title === 'string' ? doc.title : '',
    blocks,
    truncated: state.truncated,
    scanned: state.nodes,
  }
}
