import type { DestructiveCommandWarning } from '../harness/destructiveCommands.js'
import type { PermissionRule } from '../harness/permissions.js'
import type { PermissionRequestDto } from './protocol/wire.js'

/**
 * How a permission request is presented, projected from the wire DTO.
 *
 * These were pure functions inside `PermissionDialog.tsx`, typed against the
 * live `PermissionRequest`. They live here so a terminal dialog and a desktop
 * one render the same decisions from the same input, and because a renderer
 * cannot hold a `Tool`: the DTO flattens it to `toolName`/`riskLevel` and
 * carries the derived preview and destructive-command analysis with it.
 *
 * Every cross-layer import in this file is type-only, so nothing here pulls
 * the harness into a renderer bundle.
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

/** Severity of the request, for a view to map onto its own palette. */
export type PermissionTone = 'danger' | 'caution' | 'normal'

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

export function permissionOptionsForRequest(
  request: PermissionRequestDto,
): readonly PermissionOption[] {
  if (destructiveWarningsForRequest(request).length > 0) return PERMISSION_OPTIONS
  // `canAlwaysAllow` is redundant with `alwaysAllowRule` for a DTO the gate
  // built (permissions.ts sets both from one ternary), but a hand-built DTO
  // must not be able to offer an affordance that does nothing.
  if (!request.alwaysAllowRule || !request.canAlwaysAllow) return PERMISSION_OPTIONS
  return [
    ...PERMISSION_OPTIONS,
    {
      action: 'always',
      label: `Yes, always allow ${truncateMiddle(formatPermissionRuleLabel(request.alwaysAllowRule), 72)}`,
      hotkey: 'a',
    },
  ] as const
}

export function destructiveWarningsForRequest(
  request: PermissionRequestDto,
): DestructiveCommandWarning[] {
  return request.destructiveWarnings
}

export function defaultPermissionIndex(
  request: PermissionRequestDto,
  options: readonly PermissionOption[] = permissionOptionsForRequest(request),
): number {
  if (destructiveWarningsForRequest(request).length === 0) return 0
  const denyIndex = options.findIndex((option) => option.action === 'deny')
  return denyIndex === -1 ? 0 : denyIndex
}

export function permissionToneForRequest(
  request: PermissionRequestDto,
  warnings: DestructiveCommandWarning[] = destructiveWarningsForRequest(request),
): PermissionTone {
  if (warnings.length > 0) return 'danger'
  return request.riskLevel === 'dangerous' ? 'caution' : 'normal'
}

export function formatPermissionSource(request: PermissionRequestDto): string {
  return request.source
}

export function formatPermissionTitle(request: PermissionRequestDto): string {
  switch (request.toolName) {
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
  request: PermissionRequestDto,
  activeIndex: number,
  total: number,
): string {
  const parts: string[] = []
  const pathLabel = getFilePath(request.input)
  if (pathLabel) parts.push(pathLabel)
  parts.push(request.riskLevel)
  parts.push(request.source)
  if (total > 1) parts.push(`${activeIndex + 1}/${total} pending`)
  return parts.join(' - ')
}

export function formatPermissionReason(request: PermissionRequestDto): string {
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

export function formatPermissionInputBlock(request: PermissionRequestDto): PermissionInputBlock {
  if (request.toolName === 'Bash') {
    const command = isRecord(request.input) && typeof request.input.command === 'string'
      ? request.input.command
      : stringifyInput(request.input, 500)
    return { kind: 'bash', label: 'Command', content: command }
  }

  const filePath = getFilePath(request.input)
  if (filePath && isFileTool(request.toolName)) {
    return { kind: 'file', label: 'Path', content: filePath }
  }

  const content = stringifyInput(request.input, 220)
  if (!content) return { kind: 'none', label: '', content: '' }
  return { kind: 'json', label: 'Input', content }
}

/** Short label for the "Also waiting" line; subagents name their type. */
export function formatPermissionRequestLabel(request: PermissionRequestDto): string {
  if (request.toolName !== 'Agent' || !request.input || typeof request.input !== 'object') {
    return request.toolName
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
