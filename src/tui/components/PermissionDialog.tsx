import { type ReactNode, useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { PermissionDialogState } from '../types.js'
import type { PermissionRequestDto } from '../../runtime/protocol/wire.js'
import type { DestructiveCommandWarning } from '../../harness/destructiveCommands.js'
import type { FileToolPreview } from '../../services/fileToolPreview.js'
import {
  PERMISSION_OPTIONS,
  defaultPermissionIndex,
  destructiveWarningsForRequest,
  formatPermissionInputBlock,
  formatPermissionReason,
  formatPermissionRequestLabel,
  formatPermissionSubtitle,
  formatPermissionTitle,
  nextPermissionIndex,
  permissionOptionsForRequest,
  permissionToneForRequest,
  resolvePermissionOption,
  type PermissionAction,
  type PermissionInputBlock,
  type PermissionOption,
  type PermissionTone,
} from '../../runtime/permissionPresentation.js'
import { StructuredDiff } from './StructuredDiff.js'

const TONE_COLORS: Record<PermissionTone, string> = {
  danger: theme.error,
  caution: theme.warning,
  normal: theme.brand,
}

interface PermissionDialogProps {
  permState: PermissionDialogState
  respond: (id: string, approved: boolean, alwaysAllow?: boolean) => void
  setActiveRequest: (id: string) => void
}

export function PermissionDialog({ permState, respond, setActiveRequest }: PermissionDialogProps) {
  const activeIndex = Math.max(0, permState.requests.findIndex((entry) => entry.id === permState.activeRequestId))
  const activeEntry = permState.requests[activeIndex] ?? permState.requests[0]
  const request = activeEntry?.request
  const options = request ? permissionOptionsForRequest(request) : PERMISSION_OPTIONS
  const [selectedIndex, setSelectedIndex] = useState(() => request ? defaultPermissionIndex(request, options) : 0)
  // Reset selectedIndex when switching between permission requests to avoid
  // "Always allow" carrying over from one request to the next.
  useEffect(() => {
    setSelectedIndex(request ? defaultPermissionIndex(request, options) : 0)
  }, [permState.activeRequestId])
  useEffect(() => {
    setSelectedIndex((index) => Math.min(Math.max(index, 0), Math.max(options.length - 1, 0)))
  }, [options.length])

  const performAction = (action: PermissionAction) => {
    if (!activeEntry) return
    if (action === 'allow') {
      respond(activeEntry.id, true)
    } else if (action === 'deny') {
      respond(activeEntry.id, false)
    } else {
      // The hook owns the side effect: it holds the live request, and the flag
      // has to fire before the approval resolves.
      respond(activeEntry.id, true, true)
    }
  }

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => nextPermissionIndex(i, 'up', options.length))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => nextPermissionIndex(i, 'down', options.length))
      return
    }
    if (key.leftArrow || key.rightArrow || key.tab) {
      const direction = key.leftArrow ? 'up' : 'down'
      const nextIndex = nextPermissionIndex(activeIndex, direction, permState.requests.length)
      const nextEntry = permState.requests[nextIndex]
      if (nextEntry) setActiveRequest(nextEntry.id)
      return
    }
    if (key.return) {
      performAction(resolvePermissionOption(selectedIndex, options).action)
      return
    }
    if (key.escape) {
      performAction('deny')
      return
    }
    const lower = input.toLowerCase()
    const option = options.find((entry) => entry.hotkey === lower)
    if (option) performAction(option.action)
  })

  if (!request || !activeEntry) return null

  const title = formatPermissionTitle(request)
  const subtitle = formatPermissionSubtitle(request, activeIndex, permState.requests.length)
  const reason = formatPermissionReason(request)
  const inputBlock = formatPermissionInputBlock(request)
  const destructiveWarnings = destructiveWarningsForRequest(request)
  // Resolved when the request was raised, not per render.
  const filePreview = request.preview
  const otherPending = permState.requests
    .filter((entry) => entry.id !== activeEntry.id)
    .slice(0, 3)
    .map((entry) => formatPermissionRequestLabel(entry.request))
    .join(', ')

  const panelColor = TONE_COLORS[permissionToneForRequest(request, destructiveWarnings)]
  const titleRight = permState.requests.length > 1
    ? <Text color={theme.dimText}>{activeIndex + 1}/{permState.requests.length} pending</Text>
    : null

  return (
    <PermissionPanel
      title={title}
      subtitle={subtitle}
      titleColor={panelColor}
      color={panelColor}
      titleRight={titleRight}
      innerPaddingX={1}
    >
      {permState.requests.length > 1 ? (
        <Box marginTop={1}>
          <Text color={theme.dimText} wrap="truncate-end">
            Also waiting: {otherPending || 'none'}
          </Text>
        </Box>
      ) : null}
      <PermissionContentBlock
        request={request}
        reason={reason}
        inputBlock={inputBlock}
        destructiveWarnings={destructiveWarnings}
      />
      {filePreview ? <FileToolPreviewBlock preview={filePreview} /> : null}
      <PermissionPromptOptions
        options={options}
        selectedIndex={selectedIndex}
        requestCount={permState.requests.length}
      />
    </PermissionPanel>
  )
}

interface PermissionPanelProps {
  title: string
  subtitle?: string
  color: string
  titleColor: string
  innerPaddingX: number
  titleRight: ReactNode
  children: ReactNode
}

function PermissionPanel({
  title,
  subtitle,
  color,
  titleColor,
  innerPaddingX,
  titleRight,
  children,
}: PermissionPanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <PermissionRequestTitle title={title} subtitle={subtitle} color={titleColor} />
          {titleRight}
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </Box>
  )
}

function PermissionRequestTitle({
  title,
  subtitle,
  color,
}: {
  title: string
  subtitle?: string
  color: string
}) {
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{title}</Text>
      {subtitle ? <Text color={theme.dimText} wrap="truncate-start">{subtitle}</Text> : null}
    </Box>
  )
}

function PermissionContentBlock({
  request,
  reason,
  inputBlock,
  destructiveWarnings,
}: {
  request: PermissionRequestDto
  reason: string
  inputBlock: PermissionInputBlock
  destructiveWarnings: DestructiveCommandWarning[]
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.assistantText}>{reason}</Text>
      {destructiveWarnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text bold color={theme.error}>DANGER: destructive command detected</Text>
          {destructiveWarnings.map((warning) => (
            <Text key={`${warning.code}:${warning.segment}`} color={theme.error}>
              - {warning.message}
            </Text>
          ))}
        </Box>
      ) : null}
      {request.denialStreak > 1 ? (
        <Box marginTop={1}>
          <Text color={theme.warning}>
            Warning: model has hit this block {request.denialStreak}x in a row.
          </Text>
        </Box>
      ) : null}
      {inputBlock.kind !== 'none' && inputBlock.kind !== 'file' ? (
        <Box marginTop={1} paddingX={1}>
          <Text color={inputBlock.kind === 'bash' ? theme.assistantText : theme.dimText} wrap="truncate-end">
            <Text color={theme.dimText}>{inputBlock.label}: </Text>
            {inputBlock.content}
          </Text>
        </Box>
      ) : null}
      {inputBlock.kind === 'file' ? (
        <Box marginTop={1} paddingX={1}>
          <Text color={theme.dimText} wrap="truncate-start">
            {inputBlock.label}: {inputBlock.content}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function PermissionPromptOptions({
  options,
  selectedIndex,
  requestCount,
}: {
  options: readonly PermissionOption[]
  selectedIndex: number
  requestCount: number
}) {
  return (
    <>
      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text color={theme.assistantText}>Do you want to proceed?</Text>
        </Box>
        {options.map((option, index) => {
          const isSelected = index === selectedIndex
          const prefix = isSelected ? '> ' : '  '
          const upperHotkey = option.hotkey.toUpperCase()
          return (
            <Box key={option.action}>
              <Text color={isSelected ? theme.brand : theme.assistantText} bold={isSelected}>
                {prefix}[
                <Text color={hotkeyColor(option.action)} bold>
                  {upperHotkey}
                </Text>
                ] {option.label}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dimText}>
          Esc to cancel - Enter to select - y/n/a quick{requestCount > 1 ? ' - Tab switches requests' : ''}
        </Text>
      </Box>
    </>
  )
}

function FileToolPreviewBlock({ preview }: { preview: FileToolPreview }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text bold color={theme.toolName}>
        {preview.title}{preview.filePath ? `: ${preview.filePath}` : ''}
      </Text>
      {preview.kind === 'diff' ? (
        <>
          <Text color={theme.dimText}>{preview.summary}</Text>
          <StructuredDiff
            oldText={preview.oldText}
            newText={preview.newText}
            maxLines={18}
            extraRemaining={preview.elided
              ? Math.max(preview.elided.oldLines, preview.elided.newLines)
              : undefined}
          />
        </>
      ) : (
        <Text color={theme.dimText}>{preview.message}</Text>
      )}
    </Box>
  )
}

function hotkeyColor(action: PermissionAction): string {
  if (action === 'allow') return theme.success
  if (action === 'deny') return theme.error
  return theme.brand
}
