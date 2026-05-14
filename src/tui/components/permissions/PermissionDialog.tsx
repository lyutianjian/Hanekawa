import React from 'react'
import { Box, Text, useInput } from 'ink'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Theme } from '../../design-system/theme.js'

type Props = {
  title: string
  subtitle?: string
  children: React.ReactNode
  onCancel: () => void
  onApprove: () => void
  onAlwaysAllow?: () => void
  color?: keyof Theme | string
}

export function PermissionDialog({ title, subtitle, children, onCancel, onApprove, onAlwaysAllow, color = 'permission' }: Props) {
  useKeybinding('confirm:yes', onApprove, { context: 'Confirmation' })
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  useInput((input) => {
    if (input === 'a' && onAlwaysAllow) {
      onAlwaysAllow()
      return
    }
  })

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box>
        <Text color="yellow" bold>╭─ </Text>
        <Text color="yellow" bold>{title}</Text>
        {subtitle && <Text dimColor> — {subtitle}</Text>}
        <Text color="yellow" bold> ─╮</Text>
      </Box>
      <Box marginLeft={1} marginRight={1} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        {children}
      </Box>
      <Box marginLeft={1} marginTop={1}>
        <Text color="yellow" bold>╰─ </Text>
        <Text color="green" bold>[y]</Text>
        <Text> Approve</Text>
        <Text dimColor>  ·  </Text>
        <Text color="red" bold>[n]</Text>
        <Text> Deny</Text>
        {onAlwaysAllow && (
          <>
            <Text dimColor>  ·  </Text>
            <Text color="yellow" bold>[a]</Text>
            <Text> Always</Text>
          </>
        )}
        <Text color="yellow" bold> ─╯</Text>
      </Box>
    </Box>
  )
}
