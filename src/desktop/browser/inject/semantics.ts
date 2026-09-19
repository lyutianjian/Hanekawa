/**
 * The shared half of the injected collectors: what a node *is*.
 *
 * Every function here is written to be serialized. `Function.prototype.toString`
 * is what actually crosses into the page, so the rules are strict:
 *
 * - **No imports, no module-level constants, no closures.** A function may call
 *   another function in this file only because the bundler ships both; anything
 *   it reads that is not a parameter has to be passed in.
 * - **Nothing that compiles to a helper.** `lib` is ES2022 and the target is
 *   too, so `async`, spread and `for…of` survive verbatim — but `ArrayLike` is
 *   not iterable, so index loops it is.
 * - **Types are stripped, casts vanish.** `hkProp` exists precisely to launder
 *   the properties the structural interfaces in `dom.ts` deliberately omit.
 *
 * They live on the main-process side rather than in a bundled asset so that the
 * sensitive-field table, the role mapping and the truncation limits are the same
 * values the encoder and the tool description talk about — one build, one set of
 * types, one place to change a word list.
 */

import type { InjDocument, InjElement, InjNode, InjWindow } from './dom.js'

/** Reads a property the structural DOM types do not declare (`value`, `labels`, …). */
export function hkProp(el: InjElement, name: string): unknown {
  return (el as unknown as Record<string, unknown>)[name]
}

export function hkString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function hkTag(el: InjElement): string {
  return typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''
}

/**
 * Collapses whitespace and truncates — in the page, before anything crosses.
 *
 * The slice ahead of the collapse is not premature: `textContent` on a container
 * can be megabytes, and a regex over megabytes is a frozen tab.
 */
export function hkTrim(value: string, max: number): string {
  const head = value.length > max * 4 ? value.slice(0, max * 4) : value
  const collapsed = head.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

/** The parent, crossing an open shadow boundary at the host. */
export function hkParent(el: InjElement): InjElement | null {
  if (el.parentElement !== null && el.parentElement !== undefined) return el.parentElement
  const root = el.getRootNode()
  const host = root === null || root === undefined ? undefined : root.host
  return host === undefined ? null : host
}

/**
 * Visible to a human, not merely present.
 *
 * `visibility` inherits and `display: none` collapses the box, so both are
 * answered by the element's own style and its empty rect. `opacity` is the one
 * that has to be walked: a transparent ancestor leaves every descendant
 * reporting `opacity: 1` and a perfectly good rectangle.
 */
export function hkVisible(el: InjElement, win: InjWindow): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  let node: InjElement | null = el
  let depth = 0
  while (node !== null && depth < 64) {
    const style = win.getComputedStyle(node)
    if (style.display === 'none') return false
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) === 0) return false
    node = hkParent(node)
    depth += 1
  }
  return true
}

export function hkInputRole(el: InjElement): string {
  const type = hkString(el.getAttribute('type')).toLowerCase()
  if (type === 'checkbox') return 'checkbox'
  if (type === 'radio') return 'radio'
  if (type === 'range') return 'slider'
  if (type === 'number') return 'spinbutton'
  if (type === 'search') return 'searchbox'
  if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
  return 'textbox'
}

/**
 * An ARIA-ish role: the explicit one if the author wrote it, else the tag's.
 *
 * This is not the full implicit-role algorithm, and it is not trying to be. It
 * exists so the model can filter ("give me the buttons") and so a row says what
 * it is in one word; the authority for behaviour is the element, not this label.
 */
export function hkRole(el: InjElement): string {
  const explicit = hkString(el.getAttribute('role')).trim()
  if (explicit !== '') {
    const first = explicit.split(/\s+/)[0]
    if (first !== undefined && first !== '') return first
  }
  const tag = hkTag(el)
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'input') return hkInputRole(el)
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'option') return 'option'
  if (tag === 'img') return 'image'
  if (tag === 'li') return 'listitem'
  if (tag === 'ul' || tag === 'ol') return 'list'
  if (tag === 'table') return 'table'
  if (tag === 'form') return 'form'
  if (tag === 'label') return 'label'
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (el.hasAttribute('contenteditable')) return 'textbox'
  return tag === '' ? 'generic' : tag
}

/**
 * A field whose contents must never be projected.
 *
 * `autocomplete` is the load-bearing check rather than the type: a site that
 * wants its password manager to work labels the field even when it has replaced
 * `input[type=password]` with something exotic.
 */
export function hkSensitive(el: InjElement, words: string[]): boolean {
  if (hkTag(el) === 'input' && hkString(el.getAttribute('type')).toLowerCase() === 'password') return true
  const auto = hkString(el.getAttribute('autocomplete')).toLowerCase()
  if (auto === '') return false
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    if (word !== undefined && auto.indexOf(word) !== -1) return true
  }
  return false
}

export function hkText(el: InjElement, max: number): string {
  return hkTrim(el.textContent === null ? '' : el.textContent, max)
}

/**
 * The element's accessible name, by the cheap half of the real algorithm.
 *
 * The order is the one authors actually rely on. The last step — falling back to
 * the element's own text — is skipped for sensitive fields: a password input
 * whose value has leaked into a label is exactly the case that fallback would
 * happily project.
 */
export function hkName(el: InjElement, doc: InjDocument, sensitive: boolean, max: number): string {
  const aria = hkString(el.getAttribute('aria-label'))
  if (aria.trim() !== '') return hkTrim(aria, max)

  const labelledBy = hkString(el.getAttribute('aria-labelledby')).trim()
  if (labelledBy !== '') {
    const ids = labelledBy.split(/\s+/)
    let joined = ''
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i]
      const target = id === undefined ? null : doc.getElementById(id)
      if (target !== null) joined += ' ' + (target.textContent === null ? '' : target.textContent)
    }
    if (joined.trim() !== '') return hkTrim(joined, max)
  }

  const labels = hkProp(el, 'labels') as ArrayLike<InjNode> | null | undefined
  if (labels !== null && labels !== undefined && labels.length > 0) {
    let joined = ''
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i]
      if (label !== undefined && label.textContent !== null) joined += ' ' + label.textContent
    }
    if (joined.trim() !== '') return hkTrim(joined, max)
  }

  const attrs = ['alt', 'title', 'placeholder', 'aria-placeholder', 'name']
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = attrs[i]
    const value = attr === undefined ? '' : hkString(el.getAttribute(attr))
    if (value.trim() !== '') return hkTrim(value, max)
  }

  if (hkRole(el) === 'button') {
    const value = hkString(hkProp(el, 'value'))
    if (value.trim() !== '') return hkTrim(value, max)
  }

  return sensitive ? '' : hkText(el, max)
}

/**
 * Operable: on the whitelist, or a leaf the page has drawn a pointer over.
 *
 * The heuristic is there for the div-as-button, which is most buttons on the
 * modern web. It is restricted to leaves because `cursor: pointer` is inherited,
 * and without that restriction a card wrapper hands back its whole subtree.
 */
export function hkInteractive(el: InjElement, win: InjWindow, selector: string): boolean {
  if (el.matches(selector)) return true
  if (el.children.length > 0) return false
  return win.getComputedStyle(el).cursor === 'pointer'
}

/**
 * The walk both collectors share: an explicit stack, open shadow roots included.
 *
 * Recursion is avoided because a deep DOM would blow the page's stack, and the
 * budget has to be checked between nodes rather than between subtrees. Children
 * are pushed in reverse so popping yields document order, and a host's light
 * children are pushed alongside its shadow children — slotted content is
 * rendered from the light tree and would otherwise be invisible to us.
 */
export function hkWalk(
  root: InjElement,
  state: { nodes: number; maxNodes: number; deadline: number; truncated: boolean },
  visit: (el: InjElement) => boolean,
): void {
  const skip = ['script', 'style', 'noscript', 'template', 'head']
  const stack: InjElement[] = [root]
  while (stack.length > 0) {
    if (state.nodes >= state.maxNodes || Date.now() >= state.deadline) {
      state.truncated = true
      return
    }
    const el = stack.pop() as InjElement
    state.nodes += 1
    if (skip.indexOf(hkTag(el)) !== -1) continue
    if (!visit(el)) {
      state.truncated = true
      return
    }
    const shadow = el.shadowRoot
    if (shadow !== null && shadow !== undefined) {
      for (let i = shadow.children.length - 1; i >= 0; i -= 1) stack.push(shadow.children[i] as InjElement)
    }
    for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i] as InjElement)
  }
}
