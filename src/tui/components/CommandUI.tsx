import type { ReactNode } from 'react'
import { Box, Text, useStdout } from '../ink.js'
import { theme } from '../theme.js'

export interface CommandHint {
  key: string
  action: string
}

interface CommandPaneProps {
  title: string
  subtitle?: string
  children: ReactNode
  hints?: readonly CommandHint[]
  tone?: 'brand' | 'warning' | 'error'
  status?: ReactNode
}

/**
 * Shared shell for slash-command screens. The single top rule deliberately
 * keeps these screens visually attached to the prompt while giving every
 * command the same title, content and input-guide rhythm.
 */
export function CommandPane({
  title,
  subtitle,
  children,
  hints = [],
  tone = 'brand',
  status,
}: CommandPaneProps) {
  const { stdout } = useStdout()
  const width = Math.max(1, stdout.columns ?? 80)
  const color = tone === 'warning' ? theme.warning : tone === 'error' ? theme.error : theme.brand

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text color={color}>{'─'.repeat(width)}</Text>
      <Box flexDirection="column" paddingX={2}>
        <Text bold color={color}>{title}</Text>
        {subtitle ? <Text color={theme.dimText}>{subtitle}</Text> : null}
        <Box flexDirection="column" marginTop={1}>{children}</Box>
        {status ? <Box marginTop={1}>{status}</Box> : null}
        {hints.length > 0 ? <CommandHintBar hints={hints} /> : null}
      </Box>
    </Box>
  )
}

export function CommandHintBar({ hints }: { hints: readonly CommandHint[] }) {
  return (
    <Box marginTop={1}>
      <Text color={theme.dimText} italic wrap="truncate-end">
        {hints.map((hint, index) => (
          <Text key={`${hint.key}-${hint.action}`}>
            {index > 0 ? ' · ' : ''}
            <Text bold>{hint.key}</Text> to {hint.action}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export function CommandTabs({
  tabs,
  selected,
}: {
  tabs: ReadonlyArray<{ id: string; label: string }>
  selected: string
}) {
  return (
    <Box>
      {tabs.map((tab, index) => {
        const active = tab.id === selected
        return (
          <Text key={tab.id}>
            {index > 0 ? '  ' : ''}
            <Text
              bold={active}
              inverse={active}
              color={active ? theme.brand : theme.dimText}
            >
              {active ? `[${tab.label}]` : ` ${tab.label} `}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

interface CommandListItemProps {
  focused: boolean
  children: ReactNode
  description?: ReactNode
  selected?: boolean
  disabled?: boolean
  showMoreAbove?: boolean
  showMoreBelow?: boolean
}

export function CommandListItem({
  focused,
  children,
  description,
  selected = false,
  disabled = false,
  showMoreAbove = false,
  showMoreBelow = false,
}: CommandListItemProps) {
  const indicator = disabled ? ' ' : focused ? '❯' : showMoreAbove ? '↑' : showMoreBelow ? '↓' : ' '
  const color = disabled
    ? theme.dimText
    : focused
      ? theme.brand
      : selected
        ? theme.success
        : theme.assistantText

  return (
    <Box flexDirection="column">
      <Text color={color} bold={focused && !disabled}>
        {indicator} {children}
      </Text>
      {description ? (
        <Box paddingLeft={2}>
          <Text color={theme.dimText} wrap="truncate-end">{description}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export interface VisibleWindow {
  start: number
  end: number
  hasAbove: boolean
  hasBelow: boolean
}

export function getVisibleWindow(total: number, focusedIndex: number, visibleCount: number): VisibleWindow {
  if (total <= 0) return { start: 0, end: 0, hasAbove: false, hasBelow: false }
  const count = Math.max(1, Math.min(total, visibleCount))
  const focused = Math.max(0, Math.min(focusedIndex, total - 1))
  const start = Math.min(
    Math.max(0, focused - Math.floor(count / 2)),
    Math.max(0, total - count),
  )
  const end = Math.min(total, start + count)
  return { start, end, hasAbove: start > 0, hasBelow: end < total }
}

export function commandVisibleRows(terminalRows: number | undefined, chromeRows = 8, maximum = 10): number {
  return Math.max(2, Math.min(maximum, (terminalRows ?? 24) - chromeRows))
}
