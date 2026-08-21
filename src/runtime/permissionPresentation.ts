import type { DestructiveCommandWarning } from '../harness/destructiveCommands.js'
import type { PermissionRule } from '../harness/permissions.js'
import { DEFAULT_LOCALE, type Locale } from './locale.js'
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

type RiskLevel = PermissionRequestDto['riskLevel']
type DecisionSource = PermissionRequestDto['source']

/**
 * Every user-visible string here, per locale. Keyed `satisfies`, so a missing
 * translation fails the build by name rather than rendering `undefined`.
 *
 * `risk` and `source` are tables rather than raw enum values because both are
 * printed straight into the subtitle — without them a Chinese dialog reads
 * "dangerous - bash safety" in the middle of a sentence.
 */
interface PermissionStrings {
  readonly allowOnce: string
  readonly deny: string
  readonly alwaysAllow: (rule: string) => string
  readonly titles: { bash: string; write: string; edit: string; delete: string; tool: string }
  readonly subtitleJoiner: string
  readonly pending: (index: number, total: number) => string
  readonly blocks: { command: string; path: string; input: string }
  readonly sentenceTerminator: string
  readonly terminators: RegExp
  readonly risk: Record<RiskLevel, string>
  readonly source: Record<DecisionSource, string>
  readonly reasons: {
    askRule: (rule?: string) => string
    denyRule: (rule?: string) => string
    protectedPath: string
    bashSafety: string
    allowRule: (rule?: string) => string
    mode: string
  }
}

const STRINGS = {
  en: {
    allowOnce: 'Yes, allow once',
    deny: 'No, deny',
    alwaysAllow: (rule) => `Yes, always allow ${rule}`,
    titles: {
      bash: 'Bash command',
      write: 'Write file',
      edit: 'Edit file',
      delete: 'Delete file',
      tool: 'Tool permission',
    },
    subtitleJoiner: ' - ',
    pending: (index, total) => `${index}/${total} pending`,
    blocks: { command: 'Command', path: 'Path', input: 'Input' },
    sentenceTerminator: '.',
    terminators: /[.!?]$/,
    risk: { safe: 'safe', confirm: 'confirm', dangerous: 'dangerous' },
    source: {
      'ask rule': 'ask rule',
      'deny rule': 'deny rule',
      'protected path': 'protected path',
      'bash safety': 'bash safety',
      'allow rule': 'allow rule',
      mode: 'mode',
    },
    reasons: {
      askRule: (rule?: string) =>
        rule
          ? `Permission rule ${rule} requires confirmation.`
          : 'Permission rule requires confirmation.',
      denyRule: (rule?: string) =>
        rule
          ? `Permission deny rule ${rule} is blocking this action.`
          : 'Permission deny rule is blocking this action.',
      protectedPath: 'Protected path requires confirmation.',
      bashSafety: 'Shell safety check requires confirmation.',
      allowRule: (rule?: string) =>
        rule
          ? `Allow rule ${rule} matched, but safety still requires confirmation.`
          : 'Allow rule matched, but safety still requires confirmation.',
      mode: 'Current permission mode requires confirmation.',
    },
  },
  zh: {
    allowOnce: '允许一次',
    deny: '拒绝',
    alwaysAllow: (rule) => `始终允许 ${rule}`,
    titles: {
      bash: 'Bash 命令',
      write: '写入文件',
      edit: '编辑文件',
      delete: '删除文件',
      tool: '工具权限',
    },
    subtitleJoiner: ' · ',
    pending: (index, total) => `第 ${index}/${total} 条待处理`,
    blocks: { command: '命令', path: '路径', input: '输入' },
    sentenceTerminator: '。',
    terminators: /[。！？.!?]$/,
    risk: { safe: '安全', confirm: '需确认', dangerous: '危险' },
    source: {
      'ask rule': '询问规则',
      'deny rule': '拒绝规则',
      'protected path': '受保护路径',
      'bash safety': 'Shell 安全检查',
      'allow rule': '允许规则',
      mode: '权限模式',
    },
    reasons: {
      askRule: (rule?: string) => (rule ? `权限规则 ${rule} 要求确认。` : '权限规则要求确认。'),
      denyRule: (rule?: string) =>
        rule ? `拒绝规则 ${rule} 正在阻止该操作。` : '拒绝规则正在阻止该操作。',
      protectedPath: '受保护路径需要确认。',
      bashSafety: 'Shell 安全检查需要确认。',
      allowRule: (rule?: string) =>
        rule
          ? `允许规则 ${rule} 已匹配，但安全检查仍要求确认。`
          : '允许规则已匹配，但安全检查仍要求确认。',
      mode: '当前权限模式要求确认。',
    },
  },
} as const satisfies Record<Locale, PermissionStrings>

export function permissionOptions(locale: Locale = DEFAULT_LOCALE): readonly PermissionOption[] {
  const strings = STRINGS[locale]
  return [
    { action: 'allow', label: strings.allowOnce, hotkey: 'y' },
    { action: 'deny', label: strings.deny, hotkey: 'n' },
  ] as const
}

/**
 * The English pair, kept as a constant because the TUI, the runtime barrel and
 * two default parameters below already reach for it by that name.
 */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = permissionOptions('en')

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
  locale: Locale = DEFAULT_LOCALE,
): readonly PermissionOption[] {
  const base = permissionOptions(locale)
  if (destructiveWarningsForRequest(request).length > 0) return base
  // `canAlwaysAllow` is redundant with `alwaysAllowRule` for a DTO the gate
  // built (permissions.ts sets both from one ternary), but a hand-built DTO
  // must not be able to offer an affordance that does nothing.
  if (!request.alwaysAllowRule || !request.canAlwaysAllow) return base
  return [
    ...base,
    {
      action: 'always',
      label: STRINGS[locale].alwaysAllow(
        truncateMiddle(formatPermissionRuleLabel(request.alwaysAllowRule), 72),
      ),
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

export function formatPermissionSource(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return STRINGS[locale].source[request.source]
}

export function formatPermissionTitle(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const titles = STRINGS[locale].titles
  switch (request.toolName) {
    case 'Bash':
      return titles.bash
    case 'Write':
      return titles.write
    case 'Edit':
    case 'MultiEdit':
      return titles.edit
    case 'Delete':
      return titles.delete
    default:
      return titles.tool
  }
}

export function formatPermissionSubtitle(
  request: PermissionRequestDto,
  activeIndex: number,
  total: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const strings = STRINGS[locale]
  const parts: string[] = []
  const pathLabel = getFilePath(request.input)
  if (pathLabel) parts.push(pathLabel)
  parts.push(strings.risk[request.riskLevel])
  parts.push(strings.source[request.source])
  if (total > 1) parts.push(strings.pending(activeIndex + 1, total))
  return parts.join(strings.subtitleJoiner)
}

export function formatPermissionReason(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const strings = STRINGS[locale]
  const detail = normalizeSentence(request.reason, locale)
  const rule = request.matchedRule ? formatPermissionRuleLabel(request.matchedRule) : undefined
  switch (request.source) {
    case 'ask rule':
      return strings.reasons.askRule(rule)
    case 'deny rule':
      return strings.reasons.denyRule(rule)
    case 'protected path':
      return detail || strings.reasons.protectedPath
    case 'bash safety':
      return detail || strings.reasons.bashSafety
    case 'allow rule':
      return rule ? strings.reasons.allowRule(rule) : detail || strings.reasons.allowRule()
    case 'mode':
      return detail || strings.reasons.mode
  }
}

export function formatPermissionRuleLabel(rule: PermissionRule): string {
  return rule.contentPattern ? `${rule.toolName}(${rule.contentPattern})` : rule.toolName
}

export function formatPermissionInputBlock(
  request: PermissionRequestDto,
  locale: Locale = DEFAULT_LOCALE,
): PermissionInputBlock {
  const labels = STRINGS[locale].blocks
  if (request.toolName === 'Bash') {
    const command = isRecord(request.input) && typeof request.input.command === 'string'
      ? request.input.command
      : stringifyInput(request.input, 500)
    return { kind: 'bash', label: labels.command, content: command }
  }

  const filePath = getFilePath(request.input)
  if (filePath && isFileTool(request.toolName)) {
    return { kind: 'file', label: labels.path, content: filePath }
  }

  const content = stringifyInput(request.input, 220)
  if (!content) return { kind: 'none', label: '', content: '' }
  return { kind: 'json', label: labels.input, content }
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

function normalizeSentence(value: string, locale: Locale = DEFAULT_LOCALE): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const strings = STRINGS[locale]
  return strings.terminators.test(trimmed) ? trimmed : `${trimmed}${strings.sentenceTerminator}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
