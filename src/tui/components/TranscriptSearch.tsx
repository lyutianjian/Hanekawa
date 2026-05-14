import React, { useState, useMemo } from 'react'
import { Box, Text } from '../ink.js'
import { useInput } from 'ink'
import type { ChatMessage } from './messages/types.js'

type Props = {
  messages: ChatMessage[]
  onJumpTo: (index: number) => void
  onClose: () => void
}

const highlightMatch = (text: string, query: string): React.ReactNode => {
  if (!query) return <Text>{text}</Text>
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx === -1) return <Text>{text}</Text>

  return (
    <Text>
      {text.slice(0, idx)}
      <Text color="yellow" bold>{text.slice(idx, idx + query.length)}</Text>
      {text.slice(idx + query.length)}
    </Text>
  )
}

export function TranscriptSearch({ messages, onJumpTo, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)

  const matches = useMemo(() => {
    if (!query.trim()) return []
    const lower = query.toLowerCase()
    return messages
      .map((msg, index) => {
        const text = typeof msg.content === 'string' ? msg.content :
          msg.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join(' ')
        return { index, text, msg }
      })
      .filter(({ text }) => text.toLowerCase().includes(lower))
  }, [messages, query])

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.return && matches.length > 0) {
      onJumpTo(matches[selectedIdx].index)
      onClose()
      return
    }
    if (key.upArrow) {
      setSelectedIdx(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIdx(prev => Math.min(matches.length - 1, prev + 1))
      return
    }
    if (key.backspace) {
      setQuery(prev => prev.slice(0, -1))
      setSelectedIdx(0)
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery(prev => prev + input)
      setSelectedIdx(0)
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color="cyan" bold>Search: </Text>
        <Text>{query}</Text>
        <Text inverse>{' '}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {matches.length === 0 ? (
          <Text dimColor>{query ? 'No matches' : 'Type to search...'}</Text>
        ) : (
          <>
            <Text dimColor>{matches.length} matches (↑/↓ to navigate, Enter to jump)</Text>
            {matches.slice(0, 10).map((match, i) => (
              <Box key={match.index}>
                <Text color={i === selectedIdx ? 'cyan' : undefined}>
                  {i === selectedIdx ? '> ' : '  '}
                </Text>
                <Text dimColor>[{match.msg.role}] </Text>
                {highlightMatch(match.text.slice(0, 80), query)}
                {match.text.length > 80 && <Text dimColor>...</Text>}
              </Box>
            ))}
          </>
        )}
      </Box>
    </Box>
  )
}
