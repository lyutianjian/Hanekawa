import React from 'react'
import { Box, Text, useInput } from 'ink'
import { Divider } from '../design-system/Divider.js'

type Props = {
  onClose: () => void
}

export function HelpScreen({ onClose }: Props) {
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '?') {
      onClose()
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Keyboard Shortcuts</Text>
      <Divider />
      <Box flexDirection="column" marginTop={1}>
        <HelpRow shortcut="Enter" description="Send message" />
        <HelpRow shortcut="Shift+Enter" description="New line" />
        <HelpRow shortcut="Up/Down" description="History navigation" />
        <HelpRow shortcut="Tab" description="File path completion" />
        <HelpRow shortcut="Ctrl+C" description="Cancel / Interrupt" />
        <HelpRow shortcut="Ctrl+D" description="Exit" />
        <HelpRow shortcut="Ctrl+L" description="Clear screen" />
        <HelpRow shortcut="Ctrl+U" description="Clear input line" />
        <HelpRow shortcut="Ctrl+Z" description="Undo /clear" />
        <HelpRow shortcut="Ctrl+R" description="Search transcript" />
        <HelpRow shortcut="F1" description="Toggle help" />
        <HelpRow shortcut="PageUp/Down" description="Scroll messages" />
      </Box>
      <Divider />
      <Box marginTop={1}>
        <Text bold color="cyan">Slash Commands</Text>
      </Box>
      <Divider />
      <Box flexDirection="column" marginTop={1}>
        <HelpRow shortcut="/help" description="Show this help" />
        <HelpRow shortcut="/model <name>" description="Switch model" />
        <HelpRow shortcut="/clear" description="Clear conversation" />
        <HelpRow shortcut="/cost" description="Show token usage" />
        <HelpRow shortcut="/session" description="Show session info" />
        <HelpRow shortcut="/sessions" description="List all sessions" />
        <HelpRow shortcut="/switch <id>" description="Switch to session" />
        <HelpRow shortcut="/compact" description="Compact history" />
        <HelpRow shortcut="/settings" description="Open settings" />
        <HelpRow shortcut="/theme <name>" description="Switch theme (dark/light/auto)" />
        <HelpRow shortcut="/verbose" description="Toggle verbose mode" />
        <HelpRow shortcut="/export" description="Export conversation to JSON" />
        <HelpRow shortcut="/edit" description="Edit last message" />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Esc or q to close</Text>
      </Box>
    </Box>
  )
}

function HelpRow({ shortcut, description }: { shortcut: string; description: string }) {
  return (
    <Box>
      <Box width={20}>
        <Text color="yellow">{shortcut}</Text>
      </Box>
      <Text>{description}</Text>
    </Box>
  )
}
