// 复刻自 ClaudeCode/src/components/design-system/Dialog.tsx
// 简化：只实现核心 Escape 取消

import React from 'react'
import { Box, Text } from 'ink'
import { Pane } from './Pane.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Theme } from './theme.js'

type DialogProps = {
  title: string
  subtitle?: string
  children: React.ReactNode
  onCancel: () => void
  color?: keyof Theme
  hideBorder?: boolean
}

export function Dialog({ title, subtitle, children, onCancel, color = 'permission', hideBorder }: DialogProps) {
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  const content = (
    <Box flexDirection="column">
      <Box>
        <Text bold color={color as any}>{title}</Text>
        {subtitle && <Text dimColor> — {subtitle}</Text>}
      </Box>
      <Box marginTop={1}>{children}</Box>
    </Box>
  )

  if (hideBorder) return content
  return <Pane color={color}>{content}</Pane>
}
