/**
 * A tiny element builder, so no view has to reach for `innerHTML`.
 *
 * That is a hard rule here rather than a preference: transcript text, tool output
 * and diff previews are all model- or filesystem-authored, and the page runs under
 * `script-src 'self'` — which does nothing about an `onerror=` attribute in
 * interpolated markup. `textContent` is not sanitisation, it is the absence of a
 * parser.
 */

export type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  append(node, children)
  return node
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** Replaces a container's contents. `replaceChildren` over `innerHTML = ''`. */
export function replace(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren()
  append(parent, children)
}

/**
 * Puts `children` in `parent` **without detaching the ones already in place**.
 *
 * `replace()` is the wrong tool wherever the caller hands back nodes it kept: a
 * `replaceChildren` removes every child and re-inserts it, and a node that leaves
 * the document — even for the rest of one script turn — has its CSS animations
 * cancelled and restarted, and stops being an anchor `overflow-anchor` can hold a
 * scroll position by. In the transcript that meant the 220ms `unfold` replaying
 * once per streamed token: the thinking body pumped from zero height on every
 * delta and shoved the answer below it up and down.
 *
 * So this walks the two lists together and touches only what actually moved.
 * A node already at its index is left alone; anything else is inserted before the
 * child sitting there, and whatever the new list does not contain is removed.
 * Strings still become fresh text nodes, so a container filled from strings is
 * rewritten as before — those carry no animation and no anchor.
 */
export function reconcile(parent: HTMLElement, children: Child[]): void {
  const wanted: Node[] = []
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    wanted.push(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  const keep = new Set<Node>(wanted)
  for (const existing of [...parent.childNodes]) {
    if (!keep.has(existing)) parent.removeChild(existing)
  }
  // Each step makes position `index` correct, so everything before it already is.
  let index = 0
  for (const node of wanted) {
    const current: Node | undefined = parent.childNodes[index]
    if (current !== node) {
      // A tentative answer can move into its activity group after a tool call.
      // Chromium's atomic move preserves focus and animation state.
      // Detached construction and older DOMs still use ordinary insertion.
      if (parent.isConnected && node.isConnected && typeof parent.moveBefore === 'function') {
        const selection = parent.ownerDocument.getSelection()
        const selected = selection && !selection.isCollapsed
          && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))
          ? { anchor: selection.anchorNode!, start: selection.anchorOffset, focus: selection.focusNode!, end: selection.focusOffset }
          : undefined
        parent.moveBefore(node, current ?? null)
        // Atomic moves preserve focus/animations, but Chromium still adjusts
        // live Range endpoints when their ancestor changes parent.
        if (selection && selected && selected.anchor.isConnected && selected.focus.isConnected) {
          selection.setBaseAndExtent(selected.anchor, selected.start, selected.focus, selected.end)
        }
      } else parent.insertBefore(node, current ?? null)
    }
    index += 1
  }
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible
}

export function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}; index.html and the renderer are out of sync`)
  return node as T
}
