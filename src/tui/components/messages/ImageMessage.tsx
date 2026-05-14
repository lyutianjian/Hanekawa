import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  path?: string
  alt?: string
  size?: { width: number; height: number }
}

export function ImageMessage({ path, alt, size }: Props) {
  return (
    <Box marginBottom={1} paddingX={1} flexDirection="column">
      <Box>
        <Text color="magenta" bold>🖼 Image</Text>
        {alt && <Text dimColor> — {alt}</Text>}
      </Box>
      {path && (
        <Box marginLeft={2}>
          <Text dimColor>{path}</Text>
        </Box>
      )}
      {size && (
        <Box marginLeft={2}>
          <Text dimColor>{size.width}x{size.height}</Text>
        </Box>
      )}
    </Box>
  )
}
