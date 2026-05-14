import React from 'react'
import { Box, Text } from 'ink'

type Props = {
  toolName: string
  input?: unknown
  riskLevel?: 'safe' | 'confirm' | 'dangerous'
  verbose?: boolean
}

export function ToolPermissionCard({ toolName, input, riskLevel = 'confirm', verbose }: Props) {
  const riskColor = riskLevel === 'dangerous' ? 'red' : riskLevel === 'confirm' ? 'yellow' : 'green'
  const riskLabel = riskLevel === 'dangerous' ? '⚠ DANGEROUS' : riskLevel === 'confirm' ? '? CONFIRM' : '✓ SAFE'

  const inputStr = input ? JSON.stringify(input, null, 2) : ''
  const truncated = !verbose && inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{'Tool: '}</Text>
        <Text bold color="yellow">{toolName}</Text>
        <Text>{'  '}</Text>
        <Text color={riskColor}>{riskLabel}</Text>
      </Box>
      {truncated && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>{truncated}</Text>
        </Box>
      )}
    </Box>
  )
}
