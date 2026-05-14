// 复刻自 ClaudeCode/src/components/design-system/Pane.tsx
// 简化：不实现 useIsInsideModal

import React from 'react'
import { Box } from 'ink'
import { Divider } from './Divider.js'
import type { Theme } from './theme.js'

type PaneProps = {
  children: React.ReactNode
  color?: keyof Theme | string
}

export function Pane({ children, color }: PaneProps) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={color} />
      <Box flexDirection="column" paddingX={2}>{children}</Box>
    </Box>
  )
}
