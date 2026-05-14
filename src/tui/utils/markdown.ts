import chalk from 'chalk'
import type { ThemeColors } from '../design-system/ThemeProvider.js'

/**
 * Enhanced terminal markdown rendering with syntax highlighting.
 * Handles: headings (#), bold (**text**), italic (*text*), code (`text`),
 * code blocks (```), lists (- / * / 1.), links, blockquotes, horizontal rules.
 */
export function renderMarkdown(text: string, colors?: ThemeColors): string {
  const dimmedColor = colors?.dimmed ?? '#585B70'
  const accentColor = colors?.accent ?? '#89B4FA'

  let result = text

  // Code blocks (```language ... ```)
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_: string, lang: string, code: string) => {
      const highlighted = highlightCode(code.trim(), lang, colors)
      const codeBg = colors?.background ?? '#1E1E2E'
      const codeFg = colors?.foreground ?? '#CDD6F4'
      return `\n${chalk.bgHex(codeBg).hex(codeFg)(` ${lang || 'code'} `)}\n${highlighted}\n`
    },
  )

  // Inline code (`code`)
  const inlineBg = colors?.selectedBackground ?? '#313244'
  const inlineFg = colors?.foreground ?? '#CDD6F4'
  result = result.replace(
    /`([^`]+)`/g,
    (_: string, code: string) => chalk.bgHex(inlineBg).hex(inlineFg)(` ${code} `),
  )

  // Headers (# Header) - up to h6
  result = result.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_: string, title: string) => chalk.bold.hex(accentColor)(title),
  )

  // Bold (**bold**)
  result = result.replace(
    /\*\*([^*]+)\*\*/g,
    (_: string, text: string) => chalk.bold(text),
  )

  // Italic (*italic*)
  result = result.replace(
    /\*([^*]+)\*/g,
    (_: string, text: string) => chalk.italic(text),
  )

  // Links ([text](url))
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_: string, linkText: string, url: string) =>
      `${chalk.underline.hex(accentColor)(linkText)} ${chalk.dim(`(${url})`)}`,
  )

  // List items (- item or * item)
  result = result.replace(
    /^[\s]*[-*]\s+(.+)$/gm,
    (_: string, item: string) => `  ${chalk.hex(accentColor)('•')} ${item}`,
  )

  // Ordered list (1. item)
  result = result.replace(
    /^[\s]*(\d+)\.\s+(.+)$/gm,
    (_: string, num: string, item: string) => `  ${chalk.hex(accentColor)(num)}. ${item}`,
  )

  // Blockquote (> quote)
  result = result.replace(
    /^>\s+(.+)$/gm,
    (_: string, quote: string) => `${chalk.hex(dimmedColor)('│')} ${chalk.italic(quote)}`,
  )

  // Horizontal rule (--- or ***)
  result = result.replace(
    /^[-*]{3,}$/gm,
    () => chalk.hex(dimmedColor)('─'.repeat(50)),
  )

  return result
}

/**
 * Simple syntax highlighting for code blocks.
 */
function highlightCode(code: string, language: string, colors?: ThemeColors): string {
  const keywords: Record<string, string[]> = {
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'default', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw'],
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'interface', 'type', 'from', 'default', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'enum', 'extends', 'implements'],
    python: ['def', 'class', 'if', 'else', 'elif', 'for', 'while', 'import', 'from', 'return', 'try', 'except', 'with', 'as', 'pass', 'raise', 'yield', 'lambda', 'async', 'await'],
    tsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'interface', 'type', 'from', 'default', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'enum', 'extends', 'implements'],
    jsx: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'default', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw'],
  }

  const langKeywords = keywords[language] || keywords.javascript

  // Use theme colors instead of hardcoded values
  const keywordColor = colors?.accent ?? '#CBA6F7'
  const stringColor = colors?.success ?? '#A6E3A1'
  const commentColor = colors?.dimmed ?? '#6C7086'

  let highlighted = code

  // Highlight keywords
  for (const keyword of langKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'g')
    highlighted = highlighted.replace(regex, chalk.hex(keywordColor)(keyword))
  }

  // Highlight strings
  highlighted = highlighted.replace(
    /(["'])(?:(?!\1).)*\1/g,
    (match: string) => chalk.hex(stringColor)(match),
  )

  // Highlight comments (// and # style)
  highlighted = highlighted.replace(
    /(\/\/.*$|#.*$)/gm,
    (match: string) => chalk.hex(commentColor)(match),
  )

  return highlighted
}
