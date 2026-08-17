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

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible
}

export function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}; index.html and the renderer are out of sync`)
  return node as T
}
