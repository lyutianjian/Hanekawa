import React from 'react'
import { Box, Text } from 'ink'
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
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box>
        <Text color="yellow" bold>╭─ </Text>
        <Text color="yellow" bold>{title}</Text>
        {subtitle && <Text dimColor> — {subtitle}</Text>}
        <Text color="yellow" bold> ─╮</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {children}
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text color="yellow" bold>╰─ </Text>
        <Text color="green" bold>[y]</Text>
        <Text> Approve</Text>
        <Text dimColor>  ·  </Text>
        <Text color="red" bold>[n]</Text>
        <Text> Deny</Text>
        <Text color="yellow" bold> ─╯</Text>
      </Box>
    </Box>
  )
}
