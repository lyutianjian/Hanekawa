import { Box, Text } from 'ink'
import type { Token, Tokens } from 'marked'
import { parseMarkdown } from '../markdown.js'
import { theme } from '../theme.js'

interface MarkdownProps {
  content: string
}

export function Markdown({ content }: MarkdownProps) {
  const tokens = parseMarkdown(content)

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <MarkdownToken key={i} token={token} />
      ))}
    </Box>
  )
}

function MarkdownToken({ token }: { token: Token }) {
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
      return null // Skip raw HTML
    default:
      // For unknown tokens, try to render raw text
      if ('raw' in token) {
        return <Text>{(token as { raw: string }).raw}</Text>
      }
      return null
  }
}

function Heading({ token }: { token: Tokens.Heading }) {
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
}

function Paragraph({ token }: { token: Tokens.Paragraph }) {
  return (
    <Box marginY={0}>
      <Text>
        <InlineTokens tokens={token.tokens} />
      </Text>
    </Box>
  )
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const lang = token.lang ?? ''
  const lines = token.text.split('\n')

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {lang && (
        <Text color={theme.dimText} dimColor>
          {`── ${lang} ──`}
        </Text>
      )}
      {lines.map((line, i) => (
        <Text key={i} color={theme.assistantText}>
          {'  '}
          {line}
        </Text>
      ))}
    </Box>
  )
}

function List({ token }: { token: Tokens.List }) {
  return (
    <Box flexDirection="column" marginY={0}>
      {token.items.map((item, i) => (
        <ListItem key={i} token={item} index={i} ordered={token.ordered} start={typeof token.start === 'number' ? token.start : null} />
      ))}
    </Box>
  )
}

function ListItem({
  token,
  index,
  ordered,
  start,
}: {
  token: Tokens.ListItem
  index: number
  ordered: boolean | null
  start: number | null
}) {
  const bullet = ordered ? `${(start ?? 1) + index}.` : '•'
  return (
    <Box>
      <Text color={theme.dimText}>{bullet} </Text>
      <Text>
        {token.tokens.map((t, i) => {
          if (t.type === 'text') {
            return <InlineTokens key={i} tokens={(t as Tokens.Text).tokens ?? []} />
          }
          if (t.type === 'paragraph') {
            return <InlineTokens key={i} tokens={(t as Tokens.Paragraph).tokens ?? []} />
          }
          return null
        })}
      </Text>
    </Box>
  )
}

function Blockquote({ token }: { token: Tokens.Blockquote }) {
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      {token.tokens.map((t, i) => (
        <Box key={i}>
          <Text color={theme.brand}>{'│ '}</Text>
          <Text color={theme.dimText}>
            {t.type === 'paragraph' ? (
              <InlineTokens tokens={(t as Tokens.Paragraph).tokens} />
            ) : (
              ('raw' in t ? (t as { raw: string }).raw : '')
            )}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function Table({ token }: { token: Tokens.Table }) {
  // Simple table rendering - just show rows
  return (
    <Box flexDirection="column" marginY={1}>
      {token.rows.map((row, i) => (
        <Box key={i}>
          {row.map((cell, j) => (
            <Box key={j} paddingRight={2}>
              <Text>
                <InlineTokens tokens={cell.tokens} />
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// Inline token rendering
function InlineTokens({ tokens }: { tokens: Token[] }) {
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
          case 'text':
            return <Text key={i}>{(token as Tokens.Text).text}</Text>
          case 'escape':
            return <Text key={i}>{(token as Tokens.Escape).text}</Text>
          default:
            if ('raw' in token) {
              return <Text key={i}>{(token as { raw: string }).raw}</Text>
            }
            return null
        }
      })}
    </>
  )
}
