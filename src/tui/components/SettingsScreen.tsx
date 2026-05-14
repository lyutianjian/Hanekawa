import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { ListItem } from '../design-system/ListItem.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import type { ThemeSetting } from '../design-system/theme.js'

type Props = {
  onClose: () => void
}

export function SettingsScreen({ onClose }: Props) {
  const [theme, setTheme] = useTheme()
  const themeSetting = useThemeSetting()
  const [selectedIndex, setSelectedIndex] = useState(0)

  const settings = [
    { label: 'Theme', value: themeSetting, options: ['dark', 'light', 'auto'] as const },
    { label: 'Verbose', value: 'off', options: ['on', 'off'] as const },
  ]

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(prev => Math.min(settings.length - 1, prev + 1))
      return
    }
    if (key.return || input === ' ') {
      const setting = settings[selectedIndex]
      if (setting.label === 'Theme') {
        const currentIndex = (setting.options as readonly string[]).indexOf(themeSetting)
        const nextIndex = (currentIndex + 1) % setting.options.length
        setTheme(setting.options[nextIndex] as ThemeSetting)
      }
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Settings</Text>
      <Divider />
      <Box flexDirection="column" marginTop={1}>
        {settings.map((setting, i) => (
          <ListItem key={setting.label} selected={i === selectedIndex}>
            {setting.label}: {setting.value}
          </ListItem>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[↑/↓] Navigate  [Enter/Space] Toggle  [Esc] Close</Text>
      </Box>
    </Box>
  )
}
