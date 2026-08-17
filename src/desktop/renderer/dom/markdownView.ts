import type { MdBlock, MdInline, MdListItem } from '../model/markdown.js'
import { parseMarkdownBlocks } from '../model/markdown.js'
import { el, append } from './dom.js'

/**
 * `MdBlock[]` to nodes. Every decision — what is a link, what is literal text —
 * was already made by the parser, so this file is nothing but element building,
 * and it uses `el()` exclusively: no `innerHTML`, no `insertAdjacentHTML`.
 *
 * No syntax highlighting: the TUI's highlighter (`cli-highlight`) emits ANSI and
 * is Node-only, so a browser-side one is its own decision rather than something
 * to smuggle in here. A fenced block gets its language as a label instead.
 */
export function markdownNode(content: string, className = 'md'): HTMLElement {
  return el('div', className, ...parseMarkdownBlocks(content).map(blockNode))
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
  }
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
  }
}
