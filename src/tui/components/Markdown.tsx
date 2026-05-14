import React, { useMemo } from 'react'
import { Text, Box } from 'ink'
import { marked, type Token, type TokensList, type Tokens } from 'marked'
import { highlightCode } from '../utils/cliHighlight.js'

// LRU token 缓存 — 复刻自 ClaudeCode/src/components/Markdown.tsx:23-24
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, TokensList>()

// 纯文本快速路径正则 — 复刻自 ClaudeCode/src/components/Markdown.tsx:31
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.slice(0, 500))
}

function cachedLexer(content: string): TokensList {
  // 纯文本快速路径
  if (!hasMarkdownSyntax(content)) {
    return Object.assign([{ type: 'paragraph', text: content } as Tokens.Paragraph], { links: {} })
  }

  // LRU 缓存查找
  const hit = tokenCache.get(content)
  if (hit) {
    // MRU 提升
    tokenCache.delete(content)
    tokenCache.set(content, hit)
    return hit
  }

  const tokens = marked.lexer(content)
  tokenCache.set(content, tokens)

  // 缓存淘汰
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const firstKey = tokenCache.keys().next().value
    if (firstKey) tokenCache.delete(firstKey)
  }

  return tokens
}

type MarkdownProps = {
  children: string
}

/**
 * StreamingMarkdown — 流式渲染 Markdown
 * 在流式输出过程中，只渲染已完成的块，避免未完成的格式化导致闪烁
 */
export function StreamingMarkdown({ children }: { children: string }) {
  // 找到最后一个顶级块边界
  const lastBlockEnd = children.lastIndexOf('\n\n')

  if (lastBlockEnd === -1) {
    // 没有完整块，直接显示文本
    return <Text>{children}</Text>
  }

  const stablePrefix = children.slice(0, lastBlockEnd + 2)
  const streamingSuffix = children.slice(lastBlockEnd + 2)

  return (
    <>
      <Markdown>{stablePrefix}</Markdown>
      {streamingSuffix && <Text>{streamingSuffix}</Text>}
    </>
  )
}

export function Markdown({ children }: MarkdownProps) {
  const tokens = useMemo(() => cachedLexer(children), [children])

  return (
    <>
      {tokens.map((token, i) => (
        <TokenRenderer key={i} token={token} />
      ))}
    </>
  )
}

type InlinePart = { type: 'text' | 'bold' | 'italic' | 'code' | 'link'; text: string }

function parseInlineFormatting(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let remaining = text

  while (remaining.length > 0) {
    // 匹配 **bold**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/)
    if (boldMatch) {
      parts.push({ type: 'bold', text: boldMatch[1] })
      remaining = remaining.slice(boldMatch[0].length)
      continue
    }

    // 匹配 *italic*
    const italicMatch = remaining.match(/^\*(.+?)\*/)
    if (italicMatch) {
      parts.push({ type: 'italic', text: italicMatch[1] })
      remaining = remaining.slice(italicMatch[0].length)
      continue
    }

    // 匹配 `code`
    const codeMatch = remaining.match(/^`(.+?)`/)
    if (codeMatch) {
      parts.push({ type: 'code', text: codeMatch[1] })
      remaining = remaining.slice(codeMatch[0].length)
      continue
    }

    // 匹配 [text](url)
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/)
    if (linkMatch) {
      parts.push({ type: 'link', text: `${linkMatch[1]} (${linkMatch[2]})` })
      remaining = remaining.slice(linkMatch[0].length)
      continue
    }

    // 普通文本 — 读取到下一个格式标记
    const nextFormat = remaining.search(/[\[*`]/)
    if (nextFormat === -1) {
      parts.push({ type: 'text', text: remaining })
      break
    } else if (nextFormat === 0) {
      // 无法匹配的格式字符，当普通文本处理
      parts.push({ type: 'text', text: remaining[0] })
      remaining = remaining.slice(1)
    } else {
      parts.push({ type: 'text', text: remaining.slice(0, nextFormat) })
      remaining = remaining.slice(nextFormat)
    }
  }

  return parts
}

function TokenRenderer({ token }: { token: Token }): React.ReactNode {
  switch (token.type) {
    case 'heading': {
      const level = token.depth
      const prefix = '#'.repeat(level) + ' '
      return (
        <Text bold color="white">
          {prefix}{token.text}
        </Text>
      )
    }

    case 'paragraph': {
      const parts = parseInlineFormatting(token.text)
      return (
        <Text>
          {parts.map((part, i) => {
            if (part.type === 'bold') return <Text key={i} bold>{part.text}</Text>
            if (part.type === 'italic') return <Text key={i} italic>{part.text}</Text>
            if (part.type === 'code') return <Text key={i} color="green">{part.text}</Text>
            if (part.type === 'link') return <Text key={i} underline>{part.text}</Text>
            return <Text key={i}>{part.text}</Text>
          })}
        </Text>
      )
    }

    case 'code': {
      const lang = token.lang || ''
      const highlighted = highlightCode(token.text, lang || undefined)
      const highlightedLines = highlighted.split('\n')
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {lang && (
            <Box>
              <Text dimColor>{'─'.repeat(lang.length + 4)}</Text>
              <Text dimColor> {lang} </Text>
              <Text dimColor>{'─'.repeat(20)}</Text>
            </Box>
          )}
          <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
            {highlightedLines.map((line: string, i: number) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        </Box>
      )
    }

    case 'list': {
      const items = token.items || []
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1} marginLeft={1}>
          {items.map((item: Tokens.ListItem, i: number) => (
            <Box key={i}>
              <Text color="cyan">{token.ordered ? `${(token.start || 1) + i}.` : '•'}</Text>
              <Text> {item.text}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    case 'blockquote':
      return (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>│ </Text>
          <Text italic>{token.text}</Text>
        </Box>
      )

    case 'hr':
      return <Text dimColor>{'─'.repeat(40)}</Text>

    case 'space':
      return null

    case 'table': {
      const header = token.header || []
      const rows = token.rows || []

      // 计算列宽
      const colWidths = header.map((_: any, colIdx: number) => {
        const headerLen = typeof header[colIdx] === 'string' ? header[colIdx].length : (header[colIdx] as any).text?.length || 0
        const maxRowLen = rows.reduce((max: number, row: any) => {
          const cellLen = typeof row[colIdx] === 'string' ? row[colIdx].length : (row[colIdx] as any).text?.length || 0
          return Math.max(max, cellLen)
        }, 0)
        return Math.max(headerLen, maxRowLen) + 2
      })

      const renderCell = (cell: any, width: number) => {
        const text = typeof cell === 'string' ? cell : cell.text || ''
        return text.padEnd(width).slice(0, width)
      }

      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Box>
            {header.map((cell: any, i: number) => (
              <Text key={i} bold>{renderCell(cell, colWidths[i])} </Text>
            ))}
          </Box>
          <Text dimColor>{colWidths.map((w: number) => '─'.repeat(w)).join('┼')}</Text>
          {rows.map((row: any, i: number) => (
            <Box key={i}>
              {row.map((cell: any, j: number) => (
                <Text key={j}>{renderCell(cell, colWidths[j])} </Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    case 'html':
      return <Text dimColor>{token.text}</Text>

    default:
      // 其他类型（strong, em, codespan, br, del, link, image, text）
      // marked 的 inline tokens 在 paragraph 内处理
      if ('text' in token) {
        return <Text>{(token as any).text}</Text>
      }
      return null
  }
}