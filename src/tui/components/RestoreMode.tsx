import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { theme } from '../theme.js'
import type { CheckpointDiffSummary, CheckpointWithDiff } from '../../services/checkpoint/checkpointService.js'
import { commandVisibleRows, CommandHintBar, CommandListItem, CommandPane, getVisibleWindow } from './CommandUI.js'

export type RestoreDecision =
  | 'restore-code-and-conversation'
  | 'restore-conversation'
  | 'restore-code'
  | 'summarize-from-here'
  | 'summarize-up-to-here'
  | 'nevermind'

export interface RestoreModeProps {
  checkpoints: CheckpointWithDiff[]
  onSelect: (checkpoint: CheckpointWithDiff, decision: RestoreDecision) => Promise<void>
  onCancel: () => void
}

export interface RestoreOption {
  decision: RestoreDecision
  label: string
}

type RestoreScreen = 'select-node' | 'confirm'

export function RestoreMode({ checkpoints, onSelect, onCancel }: RestoreModeProps) {
  const [screen, setScreen] = useState<RestoreScreen>('select-node')
  const [selectedCheckpointIndex, setSelectedCheckpointIndex] = useState(() => checkpoints.length)
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sorted = useMemo(() => sortCheckpointsChronological(checkpoints), [checkpoints])
  const currentSelectionIndex = sorted.length
  const selectedCheckpoint = selectedCheckpointIndex === currentSelectionIndex
    ? undefined
    : sorted[selectedCheckpointIndex]
  const options = useMemo(
    () => buildRestoreOptions(selectedCheckpoint?.restoreDiff.hasChanges === true),
    [selectedCheckpoint?.restoreDiff.hasChanges],
  )

  useEffect(() => {
    setSelectedCheckpointIndex(sorted.length)
  }, [sorted.length])

  useInput((input, key) => {
    if (isLoading) return

    if (key.escape) {
      onCancel()
      return
    }

    if (screen === 'select-node') {
      if (key.upArrow) {
        setSelectedCheckpointIndex((index) => Math.max(0, index - 1))
        return
      }
      if (key.downArrow) {
        setSelectedCheckpointIndex((index) => Math.min(currentSelectionIndex, index + 1))
        return
      }
      if (key.return) {
        if (selectedCheckpointIndex === currentSelectionIndex) {
          onCancel()
          return
        }
        if (!selectedCheckpoint) return
        setSelectedOptionIndex(0)
        setError(null)
        setScreen('confirm')
      }
      return
    }

    if (key.upArrow) {
      setSelectedOptionIndex((index) => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedOptionIndex((index) => Math.min(options.length - 1, index + 1))
      return
    }

    const numericIndex = parseNumericOption(input, options.length)
    if (numericIndex !== null) {
      const option = options[numericIndex]
      if (option) {
        setSelectedOptionIndex(numericIndex)
        void resolveOption(selectedCheckpoint, option)
      }
      return
    }

    if (key.return) {
      const option = options[selectedOptionIndex]
      if (option) void resolveOption(selectedCheckpoint, option)
    }
  })

  const resolveOption = async (
    checkpoint: CheckpointWithDiff | undefined,
    option: RestoreOption,
  ): Promise<void> => {
    if (!checkpoint) return
    if (option.decision === 'nevermind') {
      setScreen('select-node')
      setSelectedOptionIndex(0)
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      await onSelect(checkpoint, option.decision)
      if (option.decision === 'summarize-from-here' || option.decision === 'summarize-up-to-here') {
        setScreen('select-node')
        setSelectedOptionIndex(0)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rewind operation failed')
    } finally {
      setIsLoading(false)
    }
  }

  if (checkpoints.length === 0) {
    return (
      <RewindPanel>
        <Box marginTop={1}>
          <Text color={theme.dimText}>No checkpoints available</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.dimText}>[Escape] Exit</Text>
        </Box>
      </RewindPanel>
    )
  }

  return (
    <RewindPanel>
      {screen === 'select-node' ? (
        <SelectNodeScreen
          checkpoints={sorted}
          selectedIndex={selectedCheckpointIndex}
          error={error}
        />
      ) : (
        <ConfirmScreen
          checkpoint={selectedCheckpoint}
          options={options}
          selectedOptionIndex={selectedOptionIndex}
          isLoading={isLoading}
          error={error}
        />
      )}
    </RewindPanel>
  )
}

function RewindPanel({ children }: { children: ReactNode }) {
  return <CommandPane title="Rewind" subtitle="Return to an earlier point in this session.">{children}</CommandPane>
}

function SelectNodeScreen({
  checkpoints,
  selectedIndex,
  error,
}: {
  checkpoints: CheckpointWithDiff[]
  selectedIndex: number
  error: string | null
}) {
  const { stdout } = useStdout()
  const visibleCount = commandVisibleRows(stdout.rows, 12, 8)
  const window = getVisibleWindow(checkpoints.length + 1, selectedIndex, visibleCount)
  const visibleCheckpointEnd = Math.min(checkpoints.length, window.end)
  const visibleCheckpoints = checkpoints.slice(window.start, visibleCheckpointEnd)
  const showCurrent = window.end > checkpoints.length
  return (
    <Box flexDirection="column">
      <Text>Restore the code and/or conversation to the point before...</Text>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {visibleCheckpoints.map((checkpoint, offset) => {
          const index = window.start + offset
          return (
          <CheckpointEntry
            key={getCheckpointRenderKey(checkpoint)}
            checkpoint={checkpoint}
            isSelected={index === selectedIndex}
            showMoreAbove={offset === 0 && window.hasAbove}
            showMoreBelow={offset === visibleCheckpoints.length - 1 && !showCurrent && window.hasBelow}
          />
          )
        })}
      </Box>
      {showCurrent ? <Box marginTop={visibleCheckpoints.length > 0 ? 1 : 0}>
        <CurrentEntry isSelected={selectedIndex === checkpoints.length} />
      </Box> : null}
      <CommandHintBar hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: 'Enter', action: 'select' },
        { key: 'Esc', action: 'close' },
      ]} />
    </Box>
  )
}

function ConfirmScreen({
  checkpoint,
  options,
  selectedOptionIndex,
  isLoading,
  error,
}: {
  checkpoint: CheckpointWithDiff | undefined
  options: readonly RestoreOption[]
  selectedOptionIndex: number
  isLoading: boolean
  error: string | null
}) {
  if (!checkpoint) return null
  const selectedDecision = options[selectedOptionIndex]?.decision
  const loadingLabel = selectedDecision === 'summarize-from-here' || selectedDecision === 'summarize-up-to-here'
    ? 'Summarizing...'
    : 'Rewinding...'
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Confirm you want to restore to the point before you sent this message:</Text>
      <Box borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.border} paddingLeft={1} marginTop={1}>
        <Box flexDirection="column">
          <Text>{truncateMessage(checkpoint.messageContent, 100) || '(no message)'}</Text>
          <Text color={theme.dimText}>{formatRelativeTime(checkpoint.timestamp)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.dimText}>The conversation will be forked.</Text>
        {checkpoint.restoreDiff.hasChanges ? (
          <Text color={theme.dimText}>
            The code will be restored {formatDiffSummary(checkpoint.restoreDiff)}.
          </Text>
        ) : (
          <Text color={theme.dimText}>The code will be unchanged.</Text>
        )}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}

      {isLoading ? (
        <Box marginTop={1}>
          <Text color={theme.brand}>{loadingLabel}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => (
            <RestoreOptionEntry
              key={option.decision}
              option={option}
              index={index}
              isSelected={index === selectedOptionIndex}
            />
          ))}
        </Box>
      )}

      {checkpoint.restoreDiff.hasChanges ? (
        <Box marginTop={1}>
          <Text color={theme.dimText}>Warning: Rewinding does not affect files edited manually or via bash.</Text>
        </Box>
      ) : null}

      <CommandHintBar hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: `1–${options.length}`, action: 'choose' },
        { key: 'Enter', action: 'confirm' },
        { key: 'Esc', action: 'back' },
      ]} />
    </Box>
  )
}

function CheckpointEntry({
  checkpoint,
  isSelected,
  showMoreAbove = false,
  showMoreBelow = false,
}: {
  checkpoint: CheckpointWithDiff
  isSelected: boolean
  showMoreAbove?: boolean
  showMoreBelow?: boolean
}) {
  const messagePreview = truncateMessage(checkpoint.messageContent.replace(/\s+/g, ' '), 88)

  return (
    <CommandListItem
      focused={isSelected}
      showMoreAbove={showMoreAbove}
      showMoreBelow={showMoreBelow}
      description={<DiffSummaryText summary={checkpoint.turnDiff} />}
    >
      {messagePreview || '(no message)'}
    </CommandListItem>
  )
}

function CurrentEntry({ isSelected }: { isSelected: boolean }) {
  return (
    <CommandListItem focused={isSelected}>(current)</CommandListItem>
  )
}

function RestoreOptionEntry({
  option,
  index,
  isSelected,
}: {
  option: RestoreOption
  index: number
  isSelected: boolean
}) {
  return (
    <Text color={isSelected ? theme.brand : theme.assistantText} bold={isSelected}>
      {isSelected ? '> ' : '  '}
      {index + 1}. {option.label}
    </Text>
  )
}

function DiffSummaryText({ summary }: { summary: CheckpointDiffSummary }) {
  if (!summary.hasChanges) {
    return <Text color={theme.dimText}>No code changes</Text>
  }
  return (
    <Text color={theme.dimText}>
      {summary.fileCount} {summary.fileCount === 1 ? 'file' : 'files'} changed{' '}
      <Text color={theme.success}>+{summary.additions}</Text>
      {' '}
      <Text color={theme.error}>-{summary.deletions}</Text>
    </Text>
  )
}

export function buildRestoreOptions(hasCodeChanges: boolean): readonly RestoreOption[] {
  const conversationOnly: RestoreOption[] = [
    { decision: 'restore-conversation', label: 'Restore conversation' },
    { decision: 'summarize-from-here', label: 'Summarize from here' },
    { decision: 'summarize-up-to-here', label: 'Summarize up to here' },
    { decision: 'nevermind', label: 'Never mind' },
  ]
  if (!hasCodeChanges) return conversationOnly
  return [
    { decision: 'restore-code-and-conversation', label: 'Restore code and conversation' },
    { decision: 'restore-conversation', label: 'Restore conversation' },
    { decision: 'restore-code', label: 'Restore code' },
    { decision: 'summarize-from-here', label: 'Summarize from here' },
    { decision: 'summarize-up-to-here', label: 'Summarize up to here' },
    { decision: 'nevermind', label: 'Never mind' },
  ]
}

export function sortCheckpointsReverseChronological(checkpoints: CheckpointWithDiff[]): CheckpointWithDiff[] {
  return [...checkpoints].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )
}

export function sortCheckpointsChronological(checkpoints: CheckpointWithDiff[]): CheckpointWithDiff[] {
  return [...checkpoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )
}

export function getCheckpointRenderKey(checkpoint: Pick<CheckpointWithDiff, 'messageId'>): string {
  return checkpoint.messageId
}

export function formatDiffSummary(summary: CheckpointDiffSummary): string {
  if (!summary.hasChanges) return 'unchanged'
  const filePart = summary.firstFile
    ? `in ${summary.firstFile}${summary.fileCount > 1 ? ` and ${summary.fileCount - 1} other ${summary.fileCount - 1 === 1 ? 'file' : 'files'}` : ''}`
    : `across ${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'}`
  return `+${summary.additions} -${summary.deletions} ${filePart}`
}

export function truncateMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return `${content.slice(0, Math.max(0, maxLength - 3))}...`
}

function parseNumericOption(input: string, optionCount: number): number | null {
  if (!/^[1-9]$/.test(input)) return null
  const index = Number.parseInt(input, 10) - 1
  return index >= 0 && index < optionCount ? index : null
}

function formatRelativeTime(isoTimestamp: string): string {
  const timestamp = new Date(isoTimestamp).getTime()
  if (!Number.isFinite(timestamp)) return isoTimestamp
  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (elapsedMs < minuteMs) return 'just now'
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m ago`
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h ago`
  return `${Math.floor(elapsedMs / dayMs)}d ago`
}
