import { marked } from 'marked'
import type { Token } from 'marked'
import { stripAnsi } from './ansi.js'

export type MarkdownToken = Token

export function parseMarkdown(content: string): MarkdownToken[] {
  return marked.lexer(content)
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
 * punctuation as natural break points. This function inserts a thin space after
 * CJK punctuation when followed by CJK ideographs, giving wrap-ansi natural
 * break opportunities at every punctuation boundary.
 */
const CJK_PUNCT_RE = /([，。！？、；：）】])(?=[一-鿿])/g

export function insertCjkBreaks(text: string): string {
  return text.replace(CJK_PUNCT_RE, '$1 ')
}
