import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { SessionMeta } from '../../sessions/service.js'
import { theme } from '../theme.js'
import { CommandListItem, CommandPane } from './CommandUI.js'

export interface SessionResumePickerProps {
  sessions: SessionMeta[]
  currentSessionId: string
  loading?: boolean
  error?: string | null
  onSelect: (session: SessionMeta) => void | Promise<void>
  onCancel: () => void
}

export function SessionResumePicker({
  sessions,
  currentSessionId,
  loading = false,
  error = null,
  onSelect,
  onCancel,
}: SessionResumePickerProps) {
  const sorted = useMemo(
    () => filterSessionsForResume(sessions, currentSessionId),
    [currentSessionId, sessions],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const { stdout } = useStdout()
  const visibleCount = Math.max(1, (stdout.rows ?? 24) - 7)
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
    Math.max(0, sorted.length - visibleCount),
  )
  const visibleSessions = sorted.slice(windowStart, windowStart + visibleCount)

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, sorted.length - 1)))
  }, [sorted.length])

  useInput((_input, key) => {
    if (loading || selecting) return
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(sorted.length - 1, index + 1))
      return
    }
    if (key.return) {
      const selected = sorted[selectedIndex]
      if (!selected) return
      setSelecting(true)
      setSelectionError(null)
      void Promise.resolve(onSelect(selected)).catch((cause) => {
        setSelectionError(cause instanceof Error ? cause.message : String(cause))
      }).finally(() => setSelecting(false))
    }
  })

  return (
    <CommandPane
      title="Resume session"
      subtitle="Sessions in the current working directory, newest first."
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: 'Enter', action: 'resume' },
        { key: 'Esc', action: 'close' },
      ]}
      status={error || selectionError
        ? <Text color={theme.error}>{error ?? selectionError}</Text>
        : selecting
          ? <Text color={theme.dimText}>Resuming session…</Text>
          : undefined}
    >
      <Box flexDirection="column" flexGrow={1}>
        {loading ? <Text color={theme.dimText}>Loading sessions...</Text> : null}
        {!loading && sorted.length === 0 ? <Text color={theme.dimText}>No sessions found.</Text> : null}
        {!loading && visibleSessions.map((session, offset) => {
          const index = windowStart + offset
          const selected = index === selectedIndex
          return (
            <CommandListItem
              key={session.id}
              focused={selected}
              selected={session.id === currentSessionId}
              showMoreAbove={offset === 0 && windowStart > 0}
              showMoreBelow={offset === visibleSessions.length - 1 && windowStart + visibleSessions.length < sorted.length}
              description={`${formatRelativeTime(session.updatedAt)} · ${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`}
            >
              {(session.title ?? '(untitled)').replace(/\s+/g, ' ')}
              {session.id === currentSessionId ? <Text color={theme.success}>  current</Text> : null}
            </CommandListItem>
          )
        })}
      </Box>
    </CommandPane>
  )
}

export function sortSessionsForResume(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function filterSessionsForResume(
  sessions: readonly SessionMeta[],
  currentSessionId: string,
): SessionMeta[] {
  return sortSessionsForResume(
    sessions.filter((session) => session.messageCount > 0 || session.id === currentSessionId),
  )
}

export function formatSessionResumeRow(session: SessionMeta, isCurrent: boolean, now = Date.now()): string {
  const title = truncateTitle((session.title ?? '(untitled)').replace(/\s+/g, ' '), 70)
  const messages = `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`
  return `${title}  ${formatRelativeTime(session.updatedAt, now)}  ${messages}${isCurrent ? '  (current)' : ''}`
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title
  return `${title.slice(0, maxLength - 3)}...`
}

function formatRelativeTime(timestamp: string, now = Date.now()): string {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) return timestamp
  const elapsed = Math.max(0, now - value)
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}
