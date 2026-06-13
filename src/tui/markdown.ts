import { marked } from 'marked'
import type { Token } from 'marked'
import { stripAnsi } from './ansi.js'

export type MarkdownToken = Token

// ── Token LRU cache ──
// marked.lexer() costs ~3ms per call.  useMemo does not survive
// unmount/remount in virtual scrolling, so a module-level cache
// keyed by content hash prevents redundant re-parsing.

const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, { tokens: Token[]; length: number }>()

// FNV-1a 32-bit hash with length suffix for collision resistance
function hashContent(s: string): string {
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV prime
  }
  return `${hash >>> 0}:${s.length}`
}

// ── Plain-text fast path ──
// Most LLM responses start with markdown syntax early.  If the first
// 500 characters contain no markdown markers we skip the full GFM
// parse and return a single synthetic paragraph token.

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // Fast path: plain text → synthetic paragraph (no lexer, no cache)
  if (!hasMarkdownSyntax(content)) {
    return [{
      type: 'paragraph',
      raw: content,
      text: content,
      tokens: [{ type: 'text', raw: content, text: content }],
    } as unknown as Token]
  }

  const key = hashContent(content)
  const cached = tokenCache.get(key)
  if (cached && cached.length === content.length) {
    // Promote to MRU (Map preserves insertion order)
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return cached.tokens
  }

  const tokens = marked.lexer(content)

  // Evict oldest entry if at capacity
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    tokenCache.delete(tokenCache.keys().next().value!)
  }
  tokenCache.set(key, { tokens, length: content.length })
  return tokens
}

export function parseMarkdown(content: string): MarkdownToken[] {
  return cachedLexer(content)
}

/**
 * Strip ANSI escape codes from text.
 * Re-exported for convenience; canonical implementation lives in ansi.ts.
 */
export const escapeAnsi = stripAnsi

/**
 * Insert break opportunities for CJK text wrapping.
 *
 * Ink's internal text wrapper (wrap-ansi) only breaks at spaces. Long CJK runs
 * without spaces are hard-broken at the exact column boundary, ignoring CJK
 * punctuation as natural break points. This function inserts break opportunities
 * at CJK punctuation boundaries and CJK↔ASCII transitions.
 */

// CJK ideograph ranges (BMP: Extension A + Unified + Compatibility)
const CJK = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF'

// CJK punctuation → CJK ideograph
const CJK_PUNCT_TO_CJK = new RegExp(
  `([，。！？、；：）】」』〉》〕］｝])(?=[${CJK}])`, 'g')

// CJK ideograph → ASCII letter/digit (mixed-script boundary)
const CJK_TO_ASCII = new RegExp(
  `([${CJK}])(?=[a-zA-Z0-9])`, 'g')

// ASCII punctuation → CJK ideograph
const ASCII_PUNCT_TO_CJK = new RegExp(
  `([.,;:!?)}\\]])(?=[${CJK}])`, 'g')

export function insertCjkBreaks(text: string): string {
  return text
    .replace(CJK_PUNCT_TO_CJK, '$1 ')
    .replace(CJK_TO_ASCII, '$1 ')
    .replace(ASCII_PUNCT_TO_CJK, '$1 ')
}
