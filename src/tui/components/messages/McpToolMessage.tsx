import React from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  serverName: string
  toolName: string
  status: 'connected' | 'disconnected' | 'error'
  toolCount?: number
}

export function McpToolMessage({ serverName, toolName, status, toolCount }: Props) {
  const statusColor = status === 'connected' ? 'green' : status === 'error' ? 'red' : 'yellow'
  const statusIcon = status === 'connected' ? '●' : status === 'error' ? '✗' : '○'

  return (
    <Box marginBottom={1} paddingX={1}>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text bold>{serverName}</Text>
      <Text dimColor>/{toolName}</Text>
      {toolCount !== undefined && (
        <Text dimColor> ({toolCount} tools)</Text>
      )}
    </Box>
  )
}
