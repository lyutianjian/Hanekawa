import React from 'react'
import { Box, Text } from 'ink'
import { Pane } from '../../design-system/Pane.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Theme } from '../../design-system/theme.js'

type Props = {
  title: string
  subtitle?: string
  children: React.ReactNode
  onCancel: () => void
  onApprove: () => void
  color?: keyof Theme
}

export function PermissionDialog({ title, subtitle, children, onCancel, onApprove, color = 'permission' }: Props) {
  useKeybinding('confirm:yes', onApprove, { context: 'Confirmation' })
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  return (
    <Pane color={color}>
      <Box flexDirection="column">
        <Box>
          <Text bold color={color as any}>{title}</Text>
          {subtitle && <Text dimColor> — {subtitle}</Text>}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{'[y]'} </Text>
          <Text color="green">Approve</Text>
          <Text dimColor>{'  [n]'} </Text>
          <Text color="red">Deny</Text>
        </Box>
      </Box>
    </Pane>
  )
}
