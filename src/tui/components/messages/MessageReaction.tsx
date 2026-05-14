import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  onReact: (reaction: string) => void
}

const REACTIONS = ['👍', '👎', '❤️', '🎯', '❓']

export function MessageReaction({ onReact }: Props) {
  const [selected, setSelected] = useState(0)

  return (
    <Box paddingX={2} paddingY={1}>
      <Text dimColor>React: </Text>
      {REACTIONS.map((r, i) => (
        <Text key={r} color={i === selected ? 'yellow' : undefined}>
          {r}{' '}
        </Text>
      ))}
    </Box>
  )
}
