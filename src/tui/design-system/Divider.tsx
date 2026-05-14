// 复刻自 ClaudeCode/src/components/design-system/Divider.tsx

import React from 'react'
import { Text, useWindowSize } from 'ink'
import type { Theme } from './theme.js'

type DividerProps = {
  width?: number
  color?: keyof Theme
  char?: string
  padding?: number
  title?: string
}

export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
}: DividerProps) {
  const { columns: terminalWidth } = useWindowSize()
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding)

  if (title) {
    const titleWidth = title.length + 2
    const sideWidth = Math.max(0, effectiveWidth - titleWidth)
    const leftWidth = Math.floor(sideWidth / 2)
    const rightWidth = sideWidth - leftWidth
    return (
      <Text color={color as any} dimColor={!color}>
        {char.repeat(leftWidth)}{' '}{title}{' '}{char.repeat(rightWidth)}
      </Text>
    )
  }

  return (
    <Text color={color as any} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </Text>
  )
}
