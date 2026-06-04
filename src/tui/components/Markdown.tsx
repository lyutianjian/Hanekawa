import { memo, useMemo } from 'react'
import { Box, Text } from 'ink'
import type { Token, Tokens } from 'marked'
import { highlight as cliHighlight } from 'cli-highlight'
import type { Theme as HighlightTheme } from 'cli-highlight'
import stringWidth from 'string-width'
import { parseMarkdown, insertCjkBreaks } from '../markdown.js'
import { theme } from '../theme.js'
import { AnsiText } from '../ansi.js'

interface MarkdownProps {
  content: string
}

export function Markdown({ content }: MarkdownProps) {
  const tokens = useMemo(() => parseMarkdown(content), [content])

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <MarkdownToken key={i} token={token} />
      ))}
    </Box>
  )
}

// ── ANSI formatter helpers for cli-highlight theme ──
// These wrap text in raw ANSI SGR codes matching our syntax theme colors.
// cli-highlight applies these to produce ANSI-colored strings which we
// then render via the AnsiText bridge component.

const esc = (r: number, g: number, b: number) => (s: string) =>
  `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function color(hex: string) {
  const [r, g, b] = hexToRgb(hex)
  return esc(r, g, b)
}

function boldColor(hex: string) {
  const [r, g, b] = hexToRgb(hex)
  return (s: string) => `\x1b[1;38;2;${r};${g};${b}m${s}\x1b[22;39m`
}

const syntaxHighlightTheme: HighlightTheme = {
  keyword: boldColor(theme.syntax.keyword),
  built_in: color(theme.syntax.builtIn),
  type: color(theme.syntax.type),
  literal: color(theme.syntax.literal),
  number: color(theme.syntax.number),
  regexp: color(theme.syntax.regexp),
  string: color(theme.syntax.string),
  comment: color(theme.syntax.comment),
  function: color(theme.syntax.function),
  title: color(theme.syntax.title),
  params: color(theme.syntax.params),
  meta: color(theme.syntax.meta),
  tag: color(theme.syntax.tag),
  name: color(theme.syntax.name),
  attr: color(theme.syntax.attr),
  section: boldColor(theme.syntax.section),
  class: color(theme.syntax.class),
  default: color(theme.syntax.default),
}

function highlightCode(code: string, lang?: string): string {
  try {
    return cliHighlight(code, {
      language: lang || undefined,
      theme: syntaxHighlightTheme,
      ignoreIllegals: true,
    })
  } catch {
    // Fallback: return raw code if highlighting fails
    return code
  }
}

// ── Block-level token dispatcher ──

const MarkdownToken = memo(function MarkdownToken({ token }: { token: Token }) {
  switch (token.type) {
    case 'heading':
      return <Heading token={token as Tokens.Heading} />
    case 'paragraph':
      return <Paragraph token={token as Tokens.Paragraph} />
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />
    case 'list':
      return <List token={token as Tokens.List} />
    case 'blockquote':
      return <Blockquote token={token as Tokens.Blockquote} />
    case 'hr':
      return <Text color={theme.dimText}>{'─'.repeat(40)}</Text>
    case 'space':
      return null
    case 'table':
      return <Table token={token as Tokens.Table} />
    case 'html':
      return <HtmlBlock token={token as Tokens.HTML} />
    default:
      if ('raw' in token) {
        return <Text>{(token as { raw: string }).raw}</Text>
      }
      return null
  }
})

// ── Heading ──

const Heading = memo(function Heading({ token }: { token: Tokens.Heading }) {
  const prefix = '#'.repeat(token.depth) + ' '
  return (
    <Box marginY={1}>
      <Text color={theme.brand} bold>
        {prefix}
      </Text>
      <Text color={theme.brand} bold>
        <InlineTokens tokens={token.tokens} />
      </Text>
    </Box>
  )
})

// ── Paragraph ──

const Paragraph = memo(function Paragraph({ token }: { token: Tokens.Paragraph }) {
  return (
    <Box marginY={0}>
      <Text>
        <InlineTokens tokens={token.tokens} />
      </Text>
    </Box>
  )
})

// ── Code Block (with syntax highlighting) ──

const CodeBlock = memo(function CodeBlock({ token }: { token: Tokens.Code }) {
  const lang = token.lang ?? ''
  const lines = token.text.split('\n')
  const highlighted = highlightCode(token.text, lang || undefined)
  const highlightedLines = highlighted.split('\n')

  return (
    <Box flexDirection="column" marginY={1}>
      {lang && (
        <Box paddingLeft={1}>
          <Text color={theme.dimText} dimColor>
            {'── '}
          </Text>
          <Text color={theme.subtleText} bold>
            {lang}
          </Text>
          <Text color={theme.dimText} dimColor>
            {' ──'}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((_, i) => (
          <AnsiText key={i}>{highlightedLines[i] ?? ''}</AnsiText>
        ))}
      </Box>
    </Box>
  )
})

// ── List ──

const List = memo(function List({ token }: { token: Tokens.List }) {
  return (
    <Box flexDirection="column" marginY={0}>
      {token.items.map((item, i) => (
        <ListItem
          key={i}
          token={item}
          index={i}
          ordered={token.ordered}
          start={typeof token.start === 'number' ? token.start : 1}
          loose={token.loose}
        />
      ))}
    </Box>
  )
})

function ListItem({
  token,
  index,
  ordered,
  start,
  loose,
}: {
  token: Tokens.ListItem
  index: number
  ordered: boolean | null
  start: number
  loose: boolean
}) {
  const bullet = ordered ? `${start + index}.` : '•'

  // Check for leading checkbox
  const firstToken = token.tokens[0]
  const firstTextTokens = firstToken?.type === 'text'
    ? (firstToken as Tokens.Text).tokens ?? []
    : []
  const hasCheckbox = firstTextTokens.length > 0 && firstTextTokens[0].type === 'checkbox'

  const checkboxToken = hasCheckbox
    ? (firstTextTokens[0] as Tokens.Checkbox)
    : null

  // Get the remaining content tokens (skip the text token that contained the checkbox)
  const contentTokens = hasCheckbox
    ? token.tokens.slice(1)
    : token.tokens

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.dimText}>{bullet} </Text>
        {checkboxToken && (
          <Text color={checkboxToken.checked ? theme.success : theme.dimText}>
            {checkboxToken.checked ? '☑' : '☐'}{' '}
          </Text>
        )}
        <Text>
          {contentTokens.map((t, i) => {
            if (t.type === 'text') {
              return <InlineTokens key={i} tokens={(t as Tokens.Text).tokens ?? []} />
            }
            if (t.type === 'paragraph') {
              return <InlineTokens key={i} tokens={(t as Tokens.Paragraph).tokens} />
            }
            return null
          })}
        </Text>
      </Box>
      {/* Nested list items: render sub-lists with increased indentation */}
      {token.tokens.map((t, i) => {
        if (t.type === 'list') {
          return (
            <Box key={`nested-${i}`} paddingLeft={2}>
              <List token={t as Tokens.List} />
            </Box>
          )
        }
        // Nested code blocks, blockquotes, etc. inside list items
        if (t.type === 'code' || t.type === 'blockquote') {
          return (
            <Box key={`nested-${i}`} paddingLeft={2}>
              <MarkdownToken token={t} />
            </Box>
          )
        }
        return null
      })}
      {/* Add extra spacing for loose lists */}
      {loose && <Text>{''}</Text>}
    </Box>
  )
}

// ── Blockquote ──

const Blockquote = memo(function Blockquote({ token }: { token: Tokens.Blockquote }) {
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      {token.tokens.map((t, i) => (
        <Box key={i}>
          <Text color={theme.brand}>{'│ '}</Text>
          <Text color={theme.dimText}>
            {t.type === 'paragraph' ? (
              <InlineTokens tokens={(t as Tokens.Paragraph).tokens} />
            ) : t.type === 'blockquote' ? (
              <Blockquote token={t as Tokens.Blockquote} />
            ) : (
              ('raw' in t ? (t as { raw: string }).raw : '')
            )}
          </Text>
        </Box>
      ))}
    </Box>
  )
})

// ── Table (with header, column width, alignment) ──

const Table = memo(function Table({ token }: { token: Tokens.Table }) {
  const allRows = [token.header, ...token.rows]
  const colCount = token.header.length
  const aligns = token.align ?? []

  // Calculate max display width per column
  const colWidths: number[] = Array.from({ length: colCount }, (_, col) => {
    let max = 0
    for (const row of allRows) {
      if (row[col]) {
        const w = stringWidth(cellText(row[col]))
        if (w > max) max = w
      }
    }
    // Enforce minimum width of 3
    return Math.max(3, max)
  })

  function cellText(cell: Tokens.TableCell): string {
    // Extract plain text from cell tokens for width measurement
    return cell.tokens
      .map((t) => {
        if (t.type === 'text') return (t as Tokens.Text).text
        if ('raw' in t) return (t as { raw: string }).raw
        return ''
      })
      .join('')
  }

  function padCell(cell: Tokens.TableCell, col: number): string {
    const text = cellText(cell)
    const width = colWidths[col]
    const diff = width - stringWidth(text)
    const align = aligns[col] ?? 'left'

    if (diff <= 0) return text
    if (align === 'right') return ' '.repeat(diff) + text
    if (align === 'center') {
      const left = Math.floor(diff / 2)
      return ' '.repeat(left) + text + ' '.repeat(diff - left)
    }
    return text + ' '.repeat(diff) // left (default)
  }

  const separator = colWidths.map((w) => '─'.repeat(w)).join('─┼─')

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Header row (bold) */}
      <Box>
        {token.header.map((cell, j) => (
          <Text key={j} bold>
            {j > 0 && <Text color={theme.dimText}>{' │ '}</Text>}
            {padCell(cell, j)}
          </Text>
        ))}
      </Box>
      {/* Separator line */}
      <Box>
        <Text color={theme.dimText}>{separator}</Text>
      </Box>
      {/* Data rows */}
      {token.rows.map((row, i) => (
        <Box key={i}>
          {row.map((cell, j) => (
            <Text key={j}>
              {j > 0 && <Text color={theme.dimText}>{' │ '}</Text>}
              {padCell(cell, j)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
})

// ── HTML Block (extract text instead of silently dropping) ──

const HtmlBlock = memo(function HtmlBlock({ token }: { token: Tokens.HTML }) {
  // Strip HTML tags and extract text content
  const text = token.raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|blockquote|pre|ul|ol)[^>]*>/gi, '\n')
    .replace(/<\/?(b|strong)[^>]*>/gi, '')
    .replace(/<\/?(i|em)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) return null

  return (
    <Text color={theme.dimText} dimColor>
      {text}
    </Text>
  )
})

// ── Inline token rendering ──

const InlineTokens = memo(function InlineTokens({ tokens }: { tokens: Token[] }) {
  if (!tokens) return null

  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'strong':
            return (
              <Text key={i} bold>
                <InlineTokens tokens={(token as Tokens.Strong).tokens} />
              </Text>
            )
          case 'em':
            return (
              <Text key={i} italic>
                <InlineTokens tokens={(token as Tokens.Em).tokens} />
              </Text>
            )
          case 'del':
            return (
              <Text key={i} strikethrough color={theme.dimText}>
                <InlineTokens tokens={(token as Tokens.Del).tokens} />
              </Text>
            )
          case 'codespan':
            return (
              <Text key={i} color={theme.codeInline}>
                {(token as Tokens.Codespan).text}
              </Text>
            )
          case 'link':
            return (
              <Text key={i} color={theme.toolName} underline>
                <InlineTokens tokens={(token as Tokens.Link).tokens} />
              </Text>
            )
          case 'image': {
            const img = token as Tokens.Image
            return (
              <Text key={i}>
                <Text color={theme.dimText}>[</Text>
                <Text>{img.text || 'image'}</Text>
                <Text color={theme.dimText}>]</Text>
                <Text color={theme.toolName}>({img.href})</Text>
              </Text>
            )
          }
          case 'br':
            return <Text key={i}>{'\n'}</Text>
          case 'text':
            return <Text key={i}>{insertCjkBreaks((token as Tokens.Text).text)}</Text>
          case 'escape':
            return <Text key={i}>{insertCjkBreaks((token as Tokens.Escape).text)}</Text>
          default:
            if ('raw' in token) {
              return <Text key={i}>{(token as { raw: string }).raw}</Text>
            }
            return null
        }
      })}
    </>
  )
})
