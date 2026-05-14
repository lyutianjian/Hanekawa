import React from 'react'
import { Box, Text } from '../ink.js'
import { Divider } from '../design-system/Divider.js'

type Props = {
  isRunning: boolean
  isMultiLine?: boolean
  lineCount?: number
  pendingPermission?: boolean
}

export function Footer({ isRunning, isMultiLine, lineCount, pendingPermission }: Props) {
  return (
    <Box flexDirection="column">
      <Divider />
      <Box paddingX={1}>
        {pendingPermission ? (
          <Text color="yellow">⚠ Permission required — [y] approve [n] deny [a] always</Text>
        ) : isRunning ? (
          <Text color="cyan">⟳ Processing... [Ctrl+C to cancel]</Text>
        ) : isMultiLine ? (
          <Text dimColor>Shift+Enter: newline · Enter: send ({lineCount} lines)</Text>
        ) : (
          <Text dimColor>Enter: send · Tab: complete · /help: commands · Ctrl+D: exit</Text>
        )}
      </Box>
    </Box>
  )
}
