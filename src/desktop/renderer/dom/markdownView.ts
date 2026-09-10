import katex from 'katex'

import type { MdBlock, MdInline, MdListItem } from '../model/markdown.js'
import { parseMarkdownBlocks, parseMarkdownSegments } from '../model/markdown.js'
import { el, append } from './dom.js'

/**
 * `MdBlock[]` to nodes. Every decision — what is a link, what is literal text —
 * was already made by the parser, so this file is nothing but element building,
 * and it uses `el()` exclusively: no `innerHTML`, no `insertAdjacentHTML`.
 *
 * No syntax highlighting: the TUI's highlighter (`cli-highlight`) emits ANSI and
 * is Node-only, so a browser-side one is its own decision rather than something
 * to smuggle in here. A fenced block gets its language as a label instead.
 *
 * Maths is the one exception to "nothing but element building", and it is not a
 * hole in the rule above: `katex.render()` clears its target with `textContent`
 * and appends a tree it built through `createElement`, so the string form
 * (`renderToString`) — the one this file could not use — is never produced. See
 * `mathNode` for the options that keep it that way.
 */
export function markdownNode(content: string, className = 'md'): HTMLElement {
  return el('div', className, ...markdownChildren(content))
}

/**
 * The same blocks without a wrapper, for a caller that already owns the node they
 * go into — the transcript reuses its nodes by id (T7), so it refills an element
 * it kept rather than building a new one around the blocks.
 */
// Owned by the particular message element, never by a session id or shared
// source key. Removing that element releases its block cache as well.
const keptBlocks = new WeakMap<HTMLElement, Map<string, { signature: string; node: HTMLElement }>>()

export function markdownChildren(content: string, owner?: HTMLElement): HTMLElement[] {
  if (!owner) return parseMarkdownBlocks(content).map(blockNode)
  const previous = keptBlocks.get(owner)
  const next = new Map<string, { signature: string; node: HTMLElement }>()
  const nodes = parseMarkdownSegments(content).map((segment) => {
    const cached = previous?.get(segment.id)
    const entry = cached?.signature === segment.signature
      ? cached
      : { signature: segment.signature, node: blockNode(segment.block) }
    next.set(segment.id, entry)
    return entry.node
  })
  keptBlocks.set(owner, next)
  return nodes
}

function blockNode(block: MdBlock): HTMLElement {
  switch (block.kind) {
    case 'paragraph':
      return el('p', undefined, ...inlineNodes(block.inline))

    case 'heading': {
      const tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[block.level - 1] ?? 'h6'
      return el(tag, undefined, ...inlineNodes(block.inline))
    }

    case 'code': {
      const wrapper = el('div', 'md-code')
      if (block.lang) wrapper.appendChild(el('div', 'md-code-lang', block.lang))
      wrapper.appendChild(el('pre', undefined, el('code', undefined, block.text)))
      return wrapper
    }

    case 'list': {
      const list = block.ordered ? el('ol') : el('ul')
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start))
      for (const item of block.items) list.appendChild(listItemNode(item))
      return list
    }

    case 'quote':
      return el('blockquote', undefined, ...block.blocks.map(blockNode))

    case 'table':
      return tableNode(block)

    case 'rule':
      return el('hr')

    case 'math':
      return mathNode(block.tex, true)
  }
}

/**
 * One equation, typeset.
 *
 * The options are the load-bearing part:
 *
 *  - `trust` stays at its default `false`, which is what turns `\href`, `\url`
 *    and `\includegraphics` into errors rather than into a link or a remote
 *    fetch the transcript never asked for. Everything else here is model-authored
 *    text; this is the same call `safeHref` makes in the parser.
 *  - `maxSize` caps the lengths TeX can name, so `\rule{99999em}{99999em}` is
 *    clamped instead of pushing the transcript sideways. `maxExpand` is KaTeX's
 *    own macro-expansion limit and its default (1000) already covers the
 *    `\def`-recursion bomb.
 *  - `throwOnError` is on so the failure is *ours*: a bad expression shows as
 *    the source that produced it, in the code face, rather than through KaTeX's
 *    own red-source fallback.
 *  - `errorColor` covers the case that fallback cannot: a command that is
 *    *refused* rather than unparseable — `\href` under `trust: false` — is
 *    rendered by KaTeX as its own name and never reaches the `catch`. Its
 *    default paints that in a hard-coded red, which is exactly the thing
 *    `test/rendererStyleTokens.test.ts` exists to keep out of this renderer;
 *    `currentColor` hands the decision back to the stylesheet.
 */
function mathNode(tex: string, display: boolean): HTMLElement {
  const node = el('span', display ? 'md-math md-math-display' : 'md-math')
  try {
    katex.render(tex, node, {
      displayMode: display,
      throwOnError: true,
      maxSize: 24,
      errorColor: 'currentColor',
    })
  } catch {
    node.className = 'md-math md-math-raw'
    node.textContent = display ? `$$${tex}$$` : `$${tex}$`
  }
  return node
}

function listItemNode(item: MdListItem): HTMLElement {
  const node = el('li', item.checked === undefined ? undefined : 'md-task')
  // A real checkbox would be focusable and look editable; the state is a marker.
  if (item.checked !== undefined) {
    node.appendChild(el('span', 'md-check', item.checked ? '[x] ' : '[ ] '))
  }
  // A single paragraph is the common case and reads better unwrapped, so tight
  // items do not gain a block of vertical margin each.
  const blocks = item.blocks
  if (blocks.length === 1 && blocks[0]!.kind === 'paragraph') {
    append(node, [...inlineNodes(blocks[0]!.inline)])
    return node
  }
  append(node, blocks.map(blockNode))
  return node
}

function tableNode(block: Extract<MdBlock, { kind: 'table' }>): HTMLElement {
  const head = el('thead', undefined, el(
    'tr',
    undefined,
    ...block.header.map((cell) => el('th', undefined, ...inlineNodes(cell))),
  ))
  const body = el(
    'tbody',
    undefined,
    ...block.rows.map((row) => el(
      'tr',
      undefined,
      ...row.map((cell) => el('td', undefined, ...inlineNodes(cell))),
    )),
  )
  return el('table', 'md-table', head, body)
}

function inlineNodes(inline: readonly MdInline[]): Node[] {
  return inline.map(inlineNode)
}

function inlineNode(inline: MdInline): Node {
  switch (inline.kind) {
    case 'text':
      return document.createTextNode(inline.text)

    case 'code':
      return el('code', 'md-inline-code', inline.text)

    case 'strong':
      return el('strong', undefined, ...inlineNodes(inline.children))

    case 'em':
      return el('em', undefined, ...inlineNodes(inline.children))

    case 'del':
      return el('del', undefined, ...inlineNodes(inline.children))

    case 'link': {
      // `target="_blank"` so the click reaches `setWindowOpenHandler` in
      // `desktop/main.ts`, which denies the window and hands the URL to the OS
      // browser. Navigating this window would replace the whole UI, since the
      // renderer is a single `loadFile`.
      const anchor = el('a', undefined, ...inlineNodes(inline.children))
      anchor.href = inline.href
      anchor.target = '_blank'
      anchor.rel = 'noreferrer noopener'
      return anchor
    }

    case 'break':
      return el('br')

    case 'math':
      return mathNode(inline.tex, inline.display)
  }
}
