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

function cachedLexer(content: string): Token[] {
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
