import React from 'react'
import { Box, Text } from 'ink'

type Props = {
  tokenCount: number
  maxTokens: number
  isCompacting?: boolean
}

export function CompactionIndicator({ tokenCount, maxTokens, isCompacting }: Props) {
  const percentage = Math.round((tokenCount / maxTokens) * 100)
  const isWarning = percentage > 80
  const isCritical = percentage > 95

  if (percentage < 50 && !isCompacting) return null

  const barWidth = 20
  const filledWidth = Math.round((percentage / 100) * barWidth)
  const bar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth)

  return (
    <Box paddingX={1}>
      {isCompacting ? (
        <Text color="yellow">⟳ Compacting context...</Text>
      ) : (
        <>
          <Text color={isCritical ? 'red' : isWarning ? 'yellow' : 'green'}>
            {bar}
          </Text>
          <Text dimColor> {percentage}% ({tokenCount.toLocaleString()}/{maxTokens.toLocaleString()} tokens)</Text>
        </>
      )}
    </Box>
  )
}
