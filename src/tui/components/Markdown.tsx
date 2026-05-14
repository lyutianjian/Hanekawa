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

    case 'paragraph':
      return <Text>{token.text}</Text>

    case 'code': {
      const lang = token.lang || ''
      const highlighted = highlightCode(token.text, lang || undefined)
      const highlightedLines = highlighted.split('\n')
      return (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          {lang && <Text dimColor>{`[${lang}]`}</Text>}
          {highlightedLines.map((line: string, i: number) => (
            <Text key={i}>{'  '}{line}</Text>
          ))}
        </Box>
      )
    }

    case 'list': {
      const items = token.items || []
      return (
        <Box flexDirection="column" marginLeft={2}>
          {items.map((item: Tokens.ListItem, i: number) => (
            <Box key={i}>
              <Text>{token.ordered ? `${(token.start || 1) + i}. ` : '• '}</Text>
              <Text>{item.text}</Text>
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
      return (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          <Box>
            {header.map((cell: any, i: number) => (
              <Text key={i} bold>{typeof cell === 'string' ? cell : cell.text}{'  '}</Text>
            ))}
          </Box>
          <Text dimColor>{'─'.repeat(40)}</Text>
          {rows.map((row: any, i: number) => (
            <Box key={i}>
              {row.map((cell: any, j: number) => (
                <Text key={j}>{typeof cell === 'string' ? cell : cell.text}{'  '}</Text>
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