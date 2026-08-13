import { type ReactNode, useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { PermissionDialogRequest, PermissionDialogState } from '../types.js'
import type { PermissionRequest, PermissionRule } from '../../harness/permissions.js'
import { analyzeDestructiveCommands, type DestructiveCommandWarning } from '../../harness/destructiveCommands.js'
import { buildFileToolPreview, type FileToolPreview } from '../fileToolPreview.js'
import { StructuredDiff } from './StructuredDiff.js'

/**
 * Pure logic for the PermissionDialog component.
 *
 * These are exported and unit-tested in `test/permissionDialog.test.ts` so
 * the component itself can stay free of imperative testing infrastructure.
 */

export type PermissionAction = 'allow' | 'deny' | 'always'

export interface PermissionOption {
  readonly action: PermissionAction
  readonly label: string
  readonly hotkey: 'y' | 'n' | 'a'
}

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { action: 'allow', label: 'Yes, allow once', hotkey: 'y' },
  { action: 'deny', label: 'No, deny', hotkey: 'n' },
] as const

export type PermissionInputBlock =
  | { kind: 'bash'; label: string; content: string }
  | { kind: 'file'; label: string; content: string }
  | { kind: 'json'; label: string; content: string }
  | { kind: 'none'; label: string; content: string }

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Compute the next selected index given a direction. Bounded (no wrap-around)
 * to match the behaviour of `RestoreMode`. Out-of-range `current` values are
 * first clamped into `[0, total - 1]` before the move is applied.
 */
export function nextPermissionIndex(
  current: number,
  direction: 'up' | 'down',
  total: number,
): number {
  if (total <= 0) return 0
  const safe = clamp(current, 0, total - 1)
  if (direction === 'up') return Math.max(0, safe - 1)
  return Math.min(total - 1, safe + 1)
}

/**
 * Resolve a selected index to its action. Out-of-range indices are clamped
 * to the nearest valid option so the function is total.
 */
export function resolvePermissionAction(index: number): PermissionAction {
  return resolvePermissionOption(index).action
}

export function resolvePermissionOption(
  index: number,
  options: readonly PermissionOption[] = PERMISSION_OPTIONS,
): PermissionOption {
  const safe = clamp(index, 0, options.length - 1)
  return options[safe] ?? PERMISSION_OPTIONS[0]!
}

export function permissionOptionsForRequest(request: PermissionRequest): readonly PermissionOption[] {
  if (destructiveWarningsForRequest(request).length > 0) return PERMISSION_OPTIONS
  if (!request.alwaysAllowRule) return PERMISSION_OPTIONS
  return [
    ...PERMISSION_OPTIONS,
    {
      action: 'always',
      label: `Yes, always allow ${truncateMiddle(formatPermissionRuleLabel(request.alwaysAllowRule), 72)}`,
      hotkey: 'a',
    },
  ] as const
}

export function destructiveWarningsForRequest(request: PermissionRequest): DestructiveCommandWarning[] {
  if (request.tool.name !== 'Bash' || !isRecord(request.input) || typeof request.input.command !== 'string') return []
  return analyzeDestructiveCommands(request.input.command)
}

export function defaultPermissionIndex(
  request: PermissionRequest,
  options: readonly PermissionOption[] = permissionOptionsForRequest(request),
): number {
  if (destructiveWarningsForRequest(request).length === 0) return 0
  const denyIndex = options.findIndex((option) => option.action === 'deny')
  return denyIndex === -1 ? 0 : denyIndex
}

export function formatPermissionSource(request: PermissionRequest): string {
  return request.source
}

export function formatPermissionTitle(request: PermissionRequest): string {
  switch (request.tool.name) {
    case 'Bash':
      return 'Bash command'
    case 'Write':
      return 'Write file'
    case 'Edit':
    case 'MultiEdit':
      return 'Edit file'
    case 'Delete':
      return 'Delete file'
    default:
      return 'Tool permission'
  }
}

export function formatPermissionSubtitle(
  request: PermissionRequest,
  activeIndex: number,
  total: number,
): string {
  const parts: string[] = []
  const pathLabel = getFilePath(request.input)
  if (pathLabel) parts.push(pathLabel)
  parts.push(request.tool.riskLevel)
  parts.push(request.source)
  if (total > 1) parts.push(`${activeIndex + 1}/${total} pending`)
  return parts.join(' - ')
}

export function formatPermissionReason(request: PermissionRequest): string {
  const detail = normalizeSentence(request.reason)
  switch (request.source) {
    case 'ask rule':
      return request.matchedRule
        ? `Permission rule ${formatPermissionRuleLabel(request.matchedRule)} requires confirmation.`
        : 'Permission rule requires confirmation.'
    case 'deny rule':
      return request.matchedRule
        ? `Permission deny rule ${formatPermissionRuleLabel(request.matchedRule)} is blocking this action.`
        : 'Permission deny rule is blocking this action.'
    case 'protected path':
      return detail || 'Protected path requires confirmation.'
    case 'bash safety':
      return detail || 'Shell safety check requires confirmation.'
    case 'allow rule':
      return request.matchedRule
        ? `Allow rule ${formatPermissionRuleLabel(request.matchedRule)} matched, but safety still requires confirmation.`
        : detail || 'Allow rule matched, but safety still requires confirmation.'
    case 'mode':
      return detail || 'Current permission mode requires confirmation.'
  }
}

export function formatPermissionRuleLabel(rule: PermissionRule): string {
  return rule.contentPattern ? `${rule.toolName}(${rule.contentPattern})` : rule.toolName
}

export function formatPermissionInputBlock(request: PermissionRequest): PermissionInputBlock {
  if (request.tool.name === 'Bash') {
    const command = isRecord(request.input) && typeof request.input.command === 'string'
      ? request.input.command
      : stringifyInput(request.input, 500)
    return { kind: 'bash', label: 'Command', content: command }
  }

  const filePath = getFilePath(request.input)
  if (filePath && isFileTool(request.tool.name)) {
    return { kind: 'file', label: 'Path', content: filePath }
  }

  const content = stringifyInput(request.input, 220)
  if (!content) return { kind: 'none', label: '', content: '' }
  return { kind: 'json', label: 'Input', content }
}

interface PermissionDialogProps {
  permState: PermissionDialogState
  respond: (id: string, approved: boolean) => void
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
    setSelectedIndex((index) => clamp(index, 0, options.length - 1))
  }, [options.length])

  const performAction = (action: PermissionAction) => {
    if (!activeEntry) return
    if (action === 'allow') {
      respond(activeEntry.id, true)
    } else if (action === 'deny') {
      respond(activeEntry.id, false)
    } else {
      request?.onAlwaysAllow?.()
      respond(activeEntry.id, true)
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
  const filePreview = buildFileToolPreview(request.tool.name, request.input)
  const otherPending = permState.requests
    .filter((entry) => entry.id !== activeEntry.id)
    .slice(0, 3)
    .map(formatPermissionRequestLabel)
    .join(', ')

  const panelColor = destructiveWarnings.length > 0
    ? theme.error
    : request.tool.riskLevel === 'dangerous' ? theme.warning : theme.brand
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
  request: PermissionRequest
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
          <StructuredDiff oldText={preview.oldText} newText={preview.newText} maxLines={18} />
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

function formatPermissionRequestLabel(entry: PermissionDialogRequest): string {
  const request = entry.request
  if (request.tool.name !== 'Agent' || !request.input || typeof request.input !== 'object') {
    return request.tool.name
  }
  const subagentType = (request.input as Record<string, unknown>).subagent_type
  return typeof subagentType === 'string' ? `Agent:${subagentType}` : 'Agent'
}

function isFileTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Delete'
}

function getFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  return typeof input.filePath === 'string' ? input.filePath : undefined
}

function stringifyInput(input: unknown, maxLength: number): string {
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength - 3)}...` : raw
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const suffixLength = Math.max(8, Math.floor(maxLength / 3))
  const prefixLength = Math.max(8, maxLength - suffixLength - 3)
  return `${value.slice(0, prefixLength)}...${value.slice(value.length - suffixLength)}`
}

function normalizeSentence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
