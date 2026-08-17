import { marked } from 'marked'
import type { Token, Tokens } from 'marked'

/**
 * Markdown as data: `marked`'s lexer folded into a small union the DOM layer can
 * walk with `el()`.
 *
 * The lexer, never `marked.parse()`. The parser's whole output is an HTML string,
 * and the renderer has no way to put one on the page — `innerHTML` is banned
 * outright (see `dom/dom.ts`: model-authored text under `script-src 'self'` still
 * gets to run an `onerror=` attribute). So the HTML string is never produced in
 * the first place, and the three unsafe constructs are downgraded *here*, at parse
 * time, rather than filtered later:
 *
 *  - an `html` token becomes literal text, so no path exists that treats a tag in
 *    model output as a tag;
 *  - a link whose href is not `http:`/`https:`/`mailto:` loses the link wrapper and
 *    keeps only its text (`textContent` does nothing about `<a href="javascript:">`);
 *  - an image becomes `alt (url)` text rather than an `<img>` — the CSP's
 *    `img-src 'self' data:` would block a remote one anyway, and a remote fetch
 *    from a transcript is an exfiltration beacon.
 *
 * DOM-free on purpose: `test/` imports this, which compiles it in the base tsconfig
 * program, and that program has no DOM lib. `HTMLElement` lives in
 * `dom/markdownView.ts`.
 */

export type MdInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly MdInline[] }
  | { readonly kind: 'em'; readonly children: readonly MdInline[] }
  | { readonly kind: 'del'; readonly children: readonly MdInline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly kind: 'break' }

export interface MdListItem {
  readonly blocks: readonly MdBlock[]
  /** A GFM task item; `undefined` for an ordinary one. */
  readonly checked?: boolean
}

export type MdBlock =
  | { readonly kind: 'paragraph'; readonly inline: readonly MdInline[] }
  | { readonly kind: 'heading'; readonly level: number; readonly inline: readonly MdInline[] }
  | { readonly kind: 'code'; readonly lang: string | undefined; readonly text: string }
  | {
      readonly kind: 'list'
      readonly ordered: boolean
      readonly start: number
      readonly items: readonly MdListItem[]
    }
  | { readonly kind: 'quote'; readonly blocks: readonly MdBlock[] }
  | {
      readonly kind: 'table'
      readonly header: readonly (readonly MdInline[])[]
      readonly rows: readonly (readonly (readonly MdInline[])[])[]
    }
  | { readonly kind: 'rule' }

/** Protocols a link may keep. Everything else degrades to its own text. */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:']

export function safeHref(href: string): string | undefined {
  const trimmed = href.trim()
  // A relative or fragment target has no protocol to vet, but it also has nowhere
  // useful to go from a `file://` renderer — drop it rather than ship a dead link.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  if (!match) return undefined
  return SAFE_PROTOCOLS.includes(match[1]!.toLowerCase() + ':') ? trimmed : undefined
}

// ── parse cache ──
//
// A deliberate second copy of `src/tui/markdown.ts`'s FNV-1a LRU: `tui/` is on the
// renderer's forbidden-import list (`test/rendererImports.test.ts`), so the module
// cannot be shared. The need is sharper here than in the TUI — `transcriptView`
// rebuilds the whole list on every streamed token, so without this a single answer
// re-parses every settled assistant message thousands of times. With it, only the
// draft (whose text actually changed) is parsed.

const TOKEN_CACHE_MAX = 500
const blockCache = new Map<string, { blocks: MdBlock[]; length: number }>()

/** FNV-1a 32-bit, with the length appended: a 32-bit hash alone collides. */
function hashContent(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${hash >>> 0}:${value.length}`
}

export function parseMarkdownBlocks(content: string): MdBlock[] {
  const key = hashContent(content)
  const cached = blockCache.get(key)
  if (cached && cached.length === content.length) {
    blockCache.delete(key)
    blockCache.set(key, cached)
    return cached.blocks
  }

  const blocks = marked.lexer(content).flatMap(blockFrom)
  if (blockCache.size >= TOKEN_CACHE_MAX) blockCache.delete(blockCache.keys().next().value!)
  blockCache.set(key, { blocks, length: content.length })
  return blocks
}

/** Test seam; also useful if a session ever grows past the LRU's usefulness. */
export function resetMarkdownCache(): void {
  blockCache.clear()
}

function blockFrom(token: Token): MdBlock[] {
  switch (token.type) {
    case 'space':
    // A link reference definition renders nothing; its target is already folded
    // into the links that used it.
    case 'def':
      return []

    case 'heading': {
      const heading = token as Tokens.Heading
      return [{
        kind: 'heading',
        level: Math.min(Math.max(heading.depth, 1), 6),
        inline: inlineFrom(heading.tokens),
      }]
    }

    case 'code': {
      const code = token as Tokens.Code
      return [{ kind: 'code', lang: code.lang?.trim() || undefined, text: code.text }]
    }

    case 'blockquote': {
      const quote = token as Tokens.Blockquote
      return [{ kind: 'quote', blocks: quote.tokens.flatMap(blockFrom) }]
    }

    case 'list': {
      const list = token as Tokens.List
      return [{
        kind: 'list',
        ordered: list.ordered,
        start: typeof list.start === 'number' ? list.start : 1,
        items: list.items.map(listItemFrom),
      }]
    }

    case 'table': {
      const table = token as Tokens.Table
      return [{
        kind: 'table',
        header: table.header.map((cell) => inlineFrom(cell.tokens)),
        rows: table.rows.map((row) => row.map((cell) => inlineFrom(cell.tokens))),
      }]
    }

    case 'hr':
      return [{ kind: 'rule' }]

    case 'html':
      // The whole point: a tag in model output is text, not markup.
      return [{ kind: 'paragraph', inline: [{ kind: 'text', text: (token as Tokens.HTML).raw }] }]

    case 'paragraph':
    case 'text': {
      const block = token as Tokens.Paragraph | Tokens.Text
      const inline = block.tokens ? inlineFrom(block.tokens) : [plainText(block.text)]
      return inline.length === 0 ? [] : [{ kind: 'paragraph', inline }]
    }

    default:
      // Anything the lexer grows later, or half a construct mid-stream. Showing
      // the raw source beats throwing inside a transcript render.
      return [{ kind: 'paragraph', inline: [plainText(token.raw)] }]
  }
}

function listItemFrom(item: Tokens.ListItem): MdListItem {
  // The `checkbox` token carries the state; the item's own `checked` agrees, and
  // the token itself must not fall through to the raw-text default.
  const tokens = item.tokens.filter((token) => token.type !== 'checkbox')
  const blocks = tokens.flatMap(blockFrom)
  return item.task ? { blocks, checked: item.checked === true } : { blocks }
}

function inlineFrom(tokens: readonly Token[]): MdInline[] {
  return tokens.flatMap(inlineOne)
}

function inlineOne(token: Token): MdInline[] {
  switch (token.type) {
    case 'text':
    case 'escape': {
      const text = token as Tokens.Text | Tokens.Escape
      // A `text` token can itself carry children (a list item's body does).
      const nested = (text as Tokens.Text).tokens
      return nested ? inlineFrom(nested) : [plainText(text.text)]
    }

    case 'codespan':
      return [{ kind: 'code', text: decodeEntities((token as Tokens.Codespan).text) }]

    case 'strong':
      return [{ kind: 'strong', children: inlineFrom((token as Tokens.Strong).tokens) }]

    case 'em':
      return [{ kind: 'em', children: inlineFrom((token as Tokens.Em).tokens) }]

    case 'del':
      return [{ kind: 'del', children: inlineFrom((token as Tokens.Del).tokens) }]

    case 'br':
      return [{ kind: 'break' }]

    case 'link': {
      const link = token as Tokens.Link
      const children = inlineFrom(link.tokens)
      const href = safeHref(link.href)
      // An unsafe target keeps the words and loses the anchor.
      return href === undefined ? children : [{ kind: 'link', href, children }]
    }

    case 'image': {
      const image = token as Tokens.Image
      const alt = image.text || 'image'
      return [plainText(image.href ? `${alt} (${image.href})` : alt)]
    }

    case 'html':
      // Inline markup, same rule as the block form.
      return [plainText(token.raw)]

    default:
      return [plainText(token.raw)]
  }
}

function plainText(text: string): MdInline {
  return { kind: 'text', text: decodeEntities(text) }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * The lexer leaves entities as written, because its consumer is normally an HTML
 * renderer that hands them to the browser's parser. `textContent` has no parser, so
 * `&amp;` would reach the screen as five characters. Decoding is safe precisely
 * because the result is only ever set as text.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}
