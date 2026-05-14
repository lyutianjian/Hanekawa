import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  onCopy?: () => void
  onRetry?: () => void
  onClose: () => void
}

export function MessageActions({ onCopy, onRetry, onClose }: Props) {
  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text bold dimColor>Message Actions</Text>
      <Box marginTop={1}>
        {onCopy && (
          <Box>
            <Text color="cyan" bold>[c]</Text>
            <Text> Copy</Text>
            <Text dimColor>  </Text>
          </Box>
        )}
        {onRetry && (
          <Box>
            <Text color="cyan" bold>[r]</Text>
            <Text> Retry</Text>
            <Text dimColor>  </Text>
          </Box>
        )}
        <Box>
          <Text color="cyan" bold>[Esc]</Text>
          <Text> Close</Text>
        </Box>
      </Box>
    </Box>
  )
}
