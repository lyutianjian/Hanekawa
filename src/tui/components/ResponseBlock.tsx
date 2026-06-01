import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { theme } from '../theme.js'

const RESPONSE_PREFIX = '  ⎿ '

export function ResponseBlock({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Box width={stringWidth(RESPONSE_PREFIX)} flexShrink={0}>
        <Text color={theme.dimText} dimColor>{RESPONSE_PREFIX}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  )
}
