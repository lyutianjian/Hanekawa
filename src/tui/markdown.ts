import { marked } from 'marked'
import type { Tokens, Token } from 'marked'

export type MarkdownToken = Token

export function parseMarkdown(content: string): MarkdownToken[] {
  return marked.lexer(content)
}

export function escapeAnsi(text: string): string {
  // Strip ANSI escape codes that might be in tool output
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}
