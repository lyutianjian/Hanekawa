import { memo, useMemo } from 'react'
import { Box, Text } from 'ink'
import type { Token, Tokens } from 'marked'
import { highlight as cliHighlight } from 'cli-highlight'
import type { Theme as HighlightTheme } from 'cli-highlight'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { parseMarkdown } from '../markdown.js'
import { theme as appTheme } from '../theme.js'
import { AnsiText, stripAnsi } from '../ansi.js'
import { supportsHyperlinks, createHyperlink } from '../hyperlink.js'

// Keep Markdown's established colors while the surrounding TUI uses grayscale.
const theme = { ...appTheme, ...appTheme.markdown }

interface MarkdownProps {
  content: string
  color?: string
  width?: number
}

export function Markdown({ content, color, width }: MarkdownProps) {
  const tokens = useMemo(() => parseMarkdown(content), [content])

  return (
    <Box flexDirection="column" width={width}>
      {tokens.map((token, i) => (
        <MarkdownToken key={i} token={token} color={color} width={width} />
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

const MarkdownToken = memo(function MarkdownToken({ token, color, width }: { token: Token; color?: string; width?: number }) {
  switch (token.type) {
    case 'heading':
      return <Heading token={token as Tokens.Heading} color={color} />
    case 'paragraph':
      return <Paragraph token={token as Tokens.Paragraph} color={color} />
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />
    case 'list':
      return <List token={token as Tokens.List} color={color} width={width} />
    case 'blockquote':
      return <Blockquote token={token as Tokens.Blockquote} color={color} width={width} />
    case 'hr':
      return <Text color={theme.dimText}>{'─'.repeat(Math.max(1, (width ?? 40) - 2))}</Text>
    case 'space':
      return <Box height={1} />
    case 'table':
      return <Table token={token as Tokens.Table} color={color} width={width} />
    case 'html':
      return <HtmlBlock token={token as Tokens.HTML} />
    default:
      if ('raw' in token) {
        return <Text color={color}>{(token as { raw: string }).raw}</Text>
      }
      return null
  }
})

// ── Heading ──

const Heading = memo(function Heading({ token, color }: { token: Tokens.Heading; color?: string }) {
  const headingColor = color ?? theme.brand
  const depth = token.depth
  return (
    <Box>
      <Text
        color={headingColor}
        bold
        italic={depth === 1}
        underline={depth === 1}
        dimColor={depth >= 3}
      >
        <InlineTokens tokens={token.tokens} color={headingColor} />
      </Text>
    </Box>
  )
})

// ── Paragraph ──

const Paragraph = memo(function Paragraph({ token, color }: { token: Tokens.Paragraph; color?: string }) {
  return (
    <Box marginY={0}>
      <Text color={color}>
        <InlineTokens tokens={token.tokens} color={color} />
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
    <Box flexDirection="column">
      {lang && (
        <Box paddingLeft={2}>
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
      <Box flexDirection="column" paddingLeft={2} backgroundColor={theme.codeBg}>
        {lines.map((_, i) => (
          <AnsiText key={i}>{highlightedLines[i] ?? ''}</AnsiText>
        ))}
      </Box>
    </Box>
  )
})

// ── List ──

const List = memo(function List({ token, color, width }: { token: Tokens.List; color?: string; width?: number }) {
  const start = typeof token.start === 'number' ? token.start : 1
  const maxNumWidth = token.ordered ? String(start + token.items.length - 1).length : 0
  return (
    <Box flexDirection="column" marginY={0}>
      {token.items.map((item, i) => (
        <ListItem
          key={i}
          token={item}
          index={i}
          ordered={token.ordered}
          start={start}
          maxNumWidth={maxNumWidth}
          loose={token.loose}
          isLast={i === token.items.length - 1}
          color={color}
          width={width}
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
  maxNumWidth,
  loose,
  isLast,
  color,
  width,
}: {
  token: Tokens.ListItem
  index: number
  ordered: boolean | null
  start: number
  maxNumWidth: number
  loose: boolean
  isLast: boolean
  color?: string
  width?: number
}) {
  const bullet = ordered ? `${String(start + index).padStart(maxNumWidth)}.` : '•'
  const contentTokens = token.tokens.filter(t => t.type !== 'checkbox')
  const firstInlineIndex = contentTokens.findIndex(t => t.type === 'text' || t.type === 'paragraph')
  const firstInlineToken = firstInlineIndex >= 0 ? contentTokens[firstInlineIndex] : undefined
  const remainingTokens = contentTokens.filter((_, i) => i !== firstInlineIndex)
  const hasCheckbox = token.task
  const checkboxWidth = hasCheckbox ? 2 : 0
  const contentIndent = stringWidth(bullet) + 1 + checkboxWidth
  const nestedWidth = width === undefined ? undefined : Math.max(1, width - contentIndent)

  return (
    <Box flexDirection="column" marginBottom={loose && !isLast ? 1 : 0}>
      <Box>
        <Text color={theme.dimText}>{bullet} </Text>
        {hasCheckbox && (
          <Text color={token.checked ? theme.success : theme.dimText}>
            {token.checked ? '☑' : '☐'}{' '}
          </Text>
        )}
        <Text color={color}>
          {firstInlineToken?.type === 'text' && (
            <InlineTokens tokens={(firstInlineToken as Tokens.Text).tokens ?? []} color={color} />
          )}
          {firstInlineToken?.type === 'paragraph' && (
            <InlineTokens tokens={(firstInlineToken as Tokens.Paragraph).tokens} color={color} />
          )}
        </Text>
      </Box>
      {remainingTokens.map((t, i) => {
        if (t.type === 'space') {
          return <Box key={`space-${i}`} height={1} />
        }
        if (t.type === 'text' || t.type === 'paragraph') {
          const inlineTokens = t.type === 'text'
            ? (t as Tokens.Text).tokens ?? []
            : (t as Tokens.Paragraph).tokens
          return (
            <Box key={`paragraph-${i}`} paddingLeft={contentIndent}>
              <Text color={color}>
                <InlineTokens tokens={inlineTokens} color={color} />
              </Text>
            </Box>
          )
        }
        if (t.type === 'list') {
          return (
            <Box key={`nested-${i}`} paddingLeft={contentIndent}>
              <List token={t as Tokens.List} color={color} width={nestedWidth} />
            </Box>
          )
        }
        return (
          <Box key={`block-${i}`} paddingLeft={contentIndent}>
            <MarkdownToken token={t} color={color} width={nestedWidth} />
          </Box>
        )
      })}
    </Box>
  )
}

// ── Blockquote ──

const BLOCKQUOTE_BORDER = {
  topLeft: '▎',
  top: '─',
  topRight: '─',
  bottomLeft: '▎',
  bottom: '─',
  bottomRight: '─',
  left: '▎',
  right: '│',
} as const

const Blockquote = memo(function Blockquote({ token, color, width }: { token: Tokens.Blockquote; color?: string; width?: number }) {
  const quoteWidth = width === undefined ? undefined : Math.max(1, width - 1)
  const contentWidth = width === undefined ? undefined : Math.max(1, width - 3)
  return (
    <Box
      flexDirection="column"
      borderStyle={BLOCKQUOTE_BORDER}
      borderColor={theme.dimText}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginLeft={1}
      width={quoteWidth}
    >
      {token.tokens.map((t, i) => t.type === 'paragraph' ? (
        <Text key={i} color={color ?? theme.dimText} italic>
          <InlineTokens tokens={(t as Tokens.Paragraph).tokens} color={color ?? theme.dimText} />
        </Text>
      ) : (
        <MarkdownToken key={i} token={t} color={color ?? theme.subtleText} width={contentWidth} />
      ))}
    </Box>
  )
})

// ── Table (ANSI string rendering with word-wrap) ──

const SAFETY_MARGIN = 4
const MIN_COLUMN_WIDTH = 3
const MAX_ROW_LINES = 4

/** Wrap text to fit within a given width, returning array of lines. ANSI-aware. */
function wrapCellText(text: string, width: number, hard = false): string[] {
  if (width <= 0) return [text]
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return ['']
  const wrapped = wrapAnsi(trimmed, width, {
    hard,
    trim: false,
    wordWrap: true,
  })
  const lines = wrapped.split('\n').filter(line => line.length > 0)
  return lines.length > 0 ? lines : ['']
}

/** Pad content to targetWidth according to alignment. ANSI-aware via displayWidth param. */
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}

/** Convert inline token to ANSI-styled string for table cell rendering. */
function renderInlineTokenToAnsi(token: Token, cellColor?: string): string {
  const applyColor = cellColor ? color(cellColor) : null
  switch (token.type) {
    case 'strong':
      return `\x1b[1m${(token as Tokens.Strong).tokens.map(t => renderInlineTokenToAnsi(t, cellColor)).join('')}\x1b[22m`
    case 'em':
      return `\x1b[3m${(token as Tokens.Em).tokens.map(t => renderInlineTokenToAnsi(t, cellColor)).join('')}\x1b[23m`
    case 'del':
      return `\x1b[9m${(token as Tokens.Del).tokens.map(t => renderInlineTokenToAnsi(t, cellColor)).join('')}\x1b[29m`
    case 'codespan':
      return `${color(theme.codeInline)((token as Tokens.Codespan).text)}`
    case 'link': {
      const linkText = (token as Tokens.Link).tokens.map(t => renderInlineTokenToAnsi(t, cellColor)).join('')
      return `${color(theme.toolName)(linkText)}`
    }
    case 'text':
      return applyColor ? applyColor((token as Tokens.Text).text) : (token as Tokens.Text).text
    case 'escape':
      return applyColor ? applyColor((token as Tokens.Escape).text) : (token as Tokens.Escape).text
    default:
      if ('raw' in token) {
        return applyColor ? applyColor((token as { raw: string }).raw) : (token as { raw: string }).raw
      }
      return ''
  }
}

/** Render a table cell's inline tokens as a single ANSI-styled string. */
function renderFormattedCell(cell: Tokens.TableCell, cellColor?: string): string {
  return cell.tokens.map(t => renderInlineTokenToAnsi(t, cellColor)).join('')
}

/** Extract plain text from a cell for width measurement. */
function cellPlainText(cell: Tokens.TableCell): string {
  return cell.tokens
    .map((t) => {
      if (t.type === 'text') return (t as Tokens.Text).text
      if (t.type === 'codespan') return (t as Tokens.Codespan).text
      if ('raw' in t) return (t as { raw: string }).raw
      return ''
    })
    .join('')
}

/** Get the longest word width in a cell (minimum width to avoid breaking words). */
function getCellMinWidth(cell: Tokens.TableCell): number {
  const text = stripAnsi(renderFormattedCell(cell))
  const words = text.split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return MIN_COLUMN_WIDTH
  return Math.max(...words.map(w => stringWidth(w)), MIN_COLUMN_WIDTH)
}

/** Get ideal width (full content without wrapping). */
function getCellIdealWidth(cell: Tokens.TableCell): number {
  return Math.max(stringWidth(stripAnsi(renderFormattedCell(cell))), MIN_COLUMN_WIDTH)
}

/** Render a single row with potential multi-line cells as ANSI string array. */
function renderRowLines(
  cells: Tokens.TableCell[],
  colWidths: number[],
  aligns: ('left' | 'center' | 'right' | null)[],
  cellColor?: string,
  isHeader = false,
): string[] {
  const cellLinesArr: string[][] = cells.map((cell, col) => {
    const formatted = renderFormattedCell(cell, cellColor)
    return wrapCellText(formatted, colWidths[col]!)
  })

  const maxLines = Math.max(...cellLinesArr.map(l => l.length), 1)
  const result: string[] = []
  for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
    let line = '│'
    for (let col = 0; col < cells.length; col++) {
      const lineText = cellLinesArr[col]![lineIdx] ?? ''
      const displayWidth = stringWidth(lineText)
      const width = colWidths[col]!
      const align = isHeader ? 'center' as const : (aligns[col] ?? 'left')
      line += ' ' + padAligned(lineText, displayWidth, width, align) + ' │'
    }
    result.push(line)
  }
  return result
}

/** Render horizontal border as a single string. */
function renderBorderLine(colWidths: number[], type: 'top' | 'middle' | 'bottom'): string {
  const [left, mid, cross, right] = {
    top:    ['┌', '─', '┬', '┐'],
    middle: ['├', '─', '┼', '┤'],
    bottom: ['└', '─', '┴', '┘'],
  }[type] as [string, string, string, string]
  let line = left
  colWidths.forEach((w, i) => {
    line += mid.repeat(w + 2)
    line += i < colWidths.length - 1 ? cross : right
  })
  return line
}

/** Render vertical format (key-value pairs) for extra-narrow terminals. */
function renderVerticalFormat(
  token: Tokens.Table,
  terminalWidth: number,
  cellColor?: string,
): string {
  const lines: string[] = []
  const headers = token.header.map(h => cellPlainText(h))
  const separatorWidth = Math.min(terminalWidth - 1, 40)
  const separator = '─'.repeat(separatorWidth)
  const wrapIndent = '  '

  token.rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) {
      lines.push(separator)
    }
    row.forEach((cell, colIdx) => {
      const label = headers[colIdx] || `Column ${colIdx + 1}`
      const rawValue = stripAnsi(renderFormattedCell(cell, cellColor)).trimEnd()
      const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

      const firstLineWidth = terminalWidth - stringWidth(label) - 3
      const subsequentLineWidth = terminalWidth - wrapIndent.length - 1

      const firstPassLines = wrapCellText(value, Math.max(firstLineWidth, 10))
      const firstLine = firstPassLines[0] || ''
      let wrappedValue: string[]
      if (firstPassLines.length <= 1 || subsequentLineWidth <= firstLineWidth) {
        wrappedValue = firstPassLines
      } else {
        const remainingText = firstPassLines.slice(1).map(l => l.trim()).join(' ')
        const rewrapped = wrapCellText(remainingText, subsequentLineWidth)
        wrappedValue = [firstLine, ...rewrapped]
      }

      // Bold label + value
      lines.push(`\x1b[1m${label}:\x1b[22m ${wrappedValue[0] || ''}`)
      for (let i = 1; i < wrappedValue.length; i++) {
        const line = wrappedValue[i]!
        if (!line.trim()) continue
        lines.push(`${wrapIndent}${line}`)
      }
    })
  })
  return lines.join('\n')
}

const Table = memo(function Table({ token, color: cellColor, width }: { token: Tokens.Table; color?: string; width?: number }) {
  const terminalWidth = width ?? 80
  const allRows = [token.header, ...token.rows]
  const colCount = token.header.length
  const aligns: ('left' | 'center' | 'right' | null)[] = (token.align ?? []).map(a => a ?? 'left')

  // Step 1: Calculate minWidth (longest word) and idealWidth (full content) per column
  const minWidths = Array.from({ length: colCount }, (_, col) => {
    let max = MIN_COLUMN_WIDTH
    for (const row of allRows) {
      if (row[col]) {
        max = Math.max(max, getCellMinWidth(row[col]!))
      }
    }
    return max
  })
  const idealWidths = Array.from({ length: colCount }, (_, col) => {
    let max = MIN_COLUMN_WIDTH
    for (const row of allRows) {
      if (row[col]) {
        max = Math.max(max, getCellIdealWidth(row[col]!))
      }
    }
    return max
  })

  // Step 2: Calculate available space
  const borderOverhead = 1 + colCount * 3 // │ + (2 padding + 1 border) per col
  const availableWidth = Math.max(terminalWidth - borderOverhead - SAFETY_MARGIN, colCount * MIN_COLUMN_WIDTH)

  // Step 3: Three-stage column width allocation
  const totalMin = minWidths.reduce((a, b) => a + b, 0)
  const totalIdeal = idealWidths.reduce((a, b) => a + b, 0)

  let needsHardWrap = false
  let colWidths: number[]
  if (totalIdeal <= availableWidth) {
    // Everything fits — use ideal widths
    colWidths = idealWidths
  } else if (totalMin <= availableWidth) {
    // Need to shrink — give each column its min, distribute remaining space proportionally
    const extraSpace = availableWidth - totalMin
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!)
    const totalOverflow = overflows.reduce((a, b) => a + b, 0)
    colWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min
      const extra = Math.floor(overflows[i]! / totalOverflow * extraSpace)
      return min + extra
    })
  } else {
    // Table wider than terminal at minimum widths — shrink proportionally, allow word breaks
    needsHardWrap = true
    const scaleFactor = availableWidth / totalMin
    colWidths = minWidths.map(w => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH))
  }

  // Step 4: Check if vertical format is needed
  function calculateMaxRowLines(): number {
    let maxLines = 1
    for (const row of allRows) {
      for (let col = 0; col < row.length; col++) {
        if (row[col]) {
          const formatted = renderFormattedCell(row[col]!, cellColor)
          const wrapped = wrapCellText(formatted, colWidths[col]!, needsHardWrap)
          maxLines = Math.max(maxLines, wrapped.length)
        }
      }
    }
    return maxLines
  }

  const maxRowLines = calculateMaxRowLines()
  const useVerticalFormat = maxRowLines > MAX_ROW_LINES

  if (useVerticalFormat) {
    return (
      <Box>
        <AnsiText>{renderVerticalFormat(token, terminalWidth, cellColor)}</AnsiText>
      </Box>
    )
  }

  // Step 5: Build horizontal table as ANSI string
  const tableLines: string[] = []
  tableLines.push(renderBorderLine(colWidths, 'top'))
  tableLines.push(...renderRowLines(token.header, colWidths, aligns, cellColor, true))
  tableLines.push(renderBorderLine(colWidths, 'middle'))
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, colWidths, aligns, cellColor, false))
    if (rowIndex < token.rows.length - 1) {
      tableLines.push(renderBorderLine(colWidths, 'middle'))
    }
  })
  tableLines.push(renderBorderLine(colWidths, 'bottom'))

  // Step 6: Safety check — if any line exceeds terminal width, fall back to vertical
  const maxLineWidth = Math.max(...tableLines.map(line => stringWidth(line)))
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return (
      <Box>
        <AnsiText>{renderVerticalFormat(token, terminalWidth, cellColor)}</AnsiText>
      </Box>
    )
  }

  // Render as a single AnsiText block to prevent Ink from wrapping mid-row
  return (
    <Box>
      <AnsiText>{tableLines.join('\n')}</AnsiText>
    </Box>
  )
})

// ── HTML Block (extract text instead of silently dropping) ──

const HtmlBlock = memo(function HtmlBlock({ token }: { token: Tokens.HTML }) {
  // Strip HTML tags and extract text content
  const text = token.raw
    .replace(/<!--[\s\S]*?-->/g, '')          // HTML comments
    .replace(/<!\[CDATA\[\s\S]*?\]\]>/g, '') // CDATA sections
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|blockquote|pre|ul|ol)[^>]*>/gi, '\n')
    .replace(/<\/?(b|strong)[^>]*>/gi, '')
    .replace(/<\/?(i|em)[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')                  // remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
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

const InlineTokens = memo(function InlineTokens({ tokens, color }: { tokens: Token[]; color?: string }) {
  if (!tokens) return null

  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'strong':
            return (
              <Text key={i} bold color={color}>
                <InlineTokens tokens={(token as Tokens.Strong).tokens} color={color} />
              </Text>
            )
          case 'em':
            return (
              <Text key={i} italic color={color}>
                <InlineTokens tokens={(token as Tokens.Em).tokens} color={color} />
              </Text>
            )
          case 'del':
            return (
              <Text key={i} strikethrough color={theme.dimText}>
                <InlineTokens tokens={(token as Tokens.Del).tokens} color={color} />
              </Text>
            )
          case 'codespan':
            return (
              <Text key={i} color={theme.codeInline}>
                {(token as Tokens.Codespan).text}
              </Text>
            )
          case 'link': {
            const linkToken = token as Tokens.Link
            const href = linkToken.href
            // OSC 8 clickable hyperlink when terminal supports it
            if (supportsHyperlinks() && href) {
              const linkText = linkToken.tokens
                .map(t => renderInlineTokenToAnsi(t, theme.toolName))
                .join('')
              return <AnsiText key={i}>{createHyperlink(href, linkText)}</AnsiText>
            }
            return (
              <Text key={i} color={theme.toolName} underline>
                <InlineTokens tokens={linkToken.tokens} color={color} />
              </Text>
            )
          }
          case 'image': {
            const img = token as Tokens.Image
            return (
              <Text key={i}>
                <Text color={theme.dimText}>[</Text>
                <Text color={color}>{img.text || 'image'}</Text>
                <Text color={theme.dimText}>]</Text>
                <Text color={theme.toolName}>({img.href})</Text>
              </Text>
            )
          }
          case 'br':
            return <Text key={i}>{'\n'}</Text>
          case 'text':
            return <Text key={i} color={color}>{normalizeSoftBreaks((token as Tokens.Text).text)}</Text>
          case 'escape':
            return <Text key={i} color={color}>{normalizeSoftBreaks((token as Tokens.Escape).text)}</Text>
          default:
            if ('raw' in token) {
              return <Text key={i} color={color}>{normalizeSoftBreaks((token as { raw: string }).raw)}</Text>
            }
            return null
        }
      })}
    </>
  )
})

function normalizeSoftBreaks(text: string): string {
  return text.replace(/[ \t]*\r?\n[ \t]*/g, (match, offset: number, source: string) => {
    const before = source[offset - 1] ?? ''
    const after = source[offset + match.length] ?? ''
    return isCjkTypographyCharacter(before) || isCjkTypographyCharacter(after) ? '' : ' '
  })
}

function isCjkTypographyCharacter(value: string): boolean {
  if (!value) return false
  const codePoint = value.codePointAt(0) ?? 0
  return (codePoint >= 0x3400 && codePoint <= 0x4DBF)
    || (codePoint >= 0x4E00 && codePoint <= 0x9FFF)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0x20000 && codePoint <= 0x2FA1F)
    || (codePoint >= 0x3000 && codePoint <= 0x303F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFFEF)
}

// ── Test-only exports ──

export {
  wrapCellText,
  padAligned,
  renderBorderLine,
  renderRowLines,
  renderVerticalFormat,
  renderFormattedCell,
  cellPlainText,
  SAFETY_MARGIN,
  MIN_COLUMN_WIDTH,
  MAX_ROW_LINES,
}
