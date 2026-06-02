import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { Checkpoint } from '../../services/checkpoint/checkpointService.js'

export interface RestoreModeProps {
  checkpoints: Checkpoint[]
  onSelect: (checkpoint: Checkpoint) => Promise<void>
  onCancel: () => void
}

/**
 * RestoreMode TUI component.
 * Displays a scrollable list of checkpoints in reverse chronological order.
 * Allows the user to select a checkpoint to restore or press Escape to cancel.
 */
export function RestoreMode({ checkpoints, onSelect, onCancel }: RestoreModeProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sort checkpoints in reverse chronological order
  const sorted = [...checkpoints].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  useInput((input, key) => {
    if (isLoading) return

    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      if (sorted.length === 0) return
      const selected = sorted[selectedIndex]
      if (!selected) return

      setIsLoading(true)
      setError(null)
      onSelect(selected)
        .catch((err: Error) => {
          setError(err.message || 'Restore operation failed')
        })
        .finally(() => {
          setIsLoading(false)
        })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1))
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(sorted.length - 1, prev + 1))
    }
  })

  // Empty checkpoint list
  if (checkpoints.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} padding={1} marginY={1}>
        <Text bold color={theme.brand}>
          Restore Mode
        </Text>
        <Box marginTop={1}>
          <Text color={theme.dimText}>No checkpoints available</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.dimText}>[Escape] Exit</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} padding={1} marginY={1}>
      <Text bold color={theme.brand}>
        Restore Mode
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dimText}>
          Select a checkpoint to restore (↑/↓ to navigate, Enter to select, Escape to cancel)
        </Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}

      {isLoading ? (
        <Box marginTop={1}>
          <Text color={theme.brand}>Restoring checkpoint...</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sorted.map((checkpoint, index) => (
            <CheckpointEntry
              key={getCheckpointRenderKey(checkpoint)}
              checkpoint={checkpoint}
              isSelected={index === selectedIndex}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dimText}>[Escape] Cancel  [Enter] Restore</Text>
      </Box>
    </Box>
  )
}

export function getCheckpointRenderKey(checkpoint: Pick<Checkpoint, 'messageId'>): string {
  return checkpoint.messageId
}

interface CheckpointEntryProps {
  checkpoint: Checkpoint
  isSelected: boolean
}

function CheckpointEntry({ checkpoint, isSelected }: CheckpointEntryProps) {
  const prefix = isSelected ? '▸ ' : '  '
  const messagePreview = truncateMessage(checkpoint.messageContent, 80)
  const timestamp = formatLocalTimestamp(checkpoint.timestamp)

  return (
    <Box>
      <Text color={isSelected ? theme.brand : theme.assistantText}>
        {prefix}
        <Text color={theme.dimText}>{timestamp}</Text>
        {' '}
        {messagePreview || '(no message)'}
      </Text>
    </Box>
  )
}

/**
 * Truncate message content to at most maxLength characters.
 * Adds ellipsis if truncated.
 */
function truncateMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return content.slice(0, maxLength - 1) + '…'
}

/**
 * Format an ISO timestamp to local time display.
 */
function formatLocalTimestamp(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp)
    if (isNaN(date.getTime())) return isoTimestamp
    return date.toLocaleString()
  } catch {
    return isoTimestamp
  }
}
