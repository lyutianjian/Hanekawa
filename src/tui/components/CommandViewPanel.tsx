import { useState } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import type { CommandView } from '../../commands/types.js'
import { theme } from '../theme.js'
import { commandVisibleRows, CommandListItem, CommandPane, getVisibleWindow } from './CommandUI.js'

export function CommandViewPanel({ view, onClose }: { view: CommandView; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { stdout } = useStdout()

  useInput((_input, key) => {
    if (key.escape || key.return && view.kind === 'info') {
      onClose()
      return
    }
    if (view.kind !== 'list') return
    if (key.upArrow) setSelectedIndex((index) => Math.max(0, index - 1))
    if (key.downArrow) setSelectedIndex((index) => Math.min(Math.max(0, view.items.length - 1), index + 1))
  })

  if (view.kind === 'info') {
    return (
      <CommandPane
        title={view.title}
        subtitle={view.subtitle}
        hints={[{ key: 'Esc', action: 'close' }]}
      >
        <Box flexDirection="column">
          {view.sections.map((section, sectionIndex) => (
            <Box key={`${section.title ?? 'section'}-${sectionIndex}`} flexDirection="column" marginTop={sectionIndex > 0 ? 1 : 0}>
              {section.title ? <Text bold>{section.title}</Text> : null}
              {section.rows.map((row) => (
                <Box key={row.label} paddingLeft={section.title ? 2 : 0}>
                  <Text color={theme.dimText}>{row.label.padEnd(20)} </Text>
                  <Text color={toneColor(row.tone)}>{row.value}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </CommandPane>
    )
  }

  const visibleCount = commandVisibleRows(stdout.rows, 9, 12)
  const window = getVisibleWindow(view.items.length, selectedIndex, visibleCount)
  const visibleItems = view.items.slice(window.start, window.end)
  return (
    <CommandPane
      title={view.title}
      subtitle={view.subtitle}
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: 'Esc', action: 'close' },
      ]}
    >
      <Box flexDirection="column">
        {visibleItems.length === 0 ? <Text color={theme.dimText}>Nothing to show.</Text> : null}
        {visibleItems.map((item, offset) => (
          <CommandListItem
            key={item.id}
            focused={window.start + offset === selectedIndex}
            showMoreAbove={offset === 0 && window.hasAbove}
            showMoreBelow={offset === visibleItems.length - 1 && window.hasBelow}
            description={item.description}
          >
            {item.label}
          </CommandListItem>
        ))}
      </Box>
    </CommandPane>
  )
}

function toneColor(tone: 'normal' | 'success' | 'warning' | 'error' | undefined): string | undefined {
  if (tone === 'success') return theme.success
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  return undefined
}
