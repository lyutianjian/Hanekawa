import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { RESPONSE_PREFIX } from '../constants/figures.js'

export function ResponseBlock({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box flexShrink={0}>
        <Text color={theme.subtleText}>{RESPONSE_PREFIX}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  )
}
