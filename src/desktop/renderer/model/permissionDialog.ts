import {
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
} from '../../../runtime/permissionPresentation.js'
import type { DestructiveCommandWarning } from '../../../harness/destructiveCommands.js'
import type { PermissionRequestDto, UiResponse } from '../../../runtime/protocol/wire.js'
import { previewView, type PreviewView } from './diffRows.js'

/**
 * The permission dialog as data.
 *
 * Everything about *what* to offer comes from `runtime/permissionPresentation.ts`
 * — the same module the terminal dialog uses — so the two cannot drift on the
 * two decisions that matter: whether "always allow" is offered at all, and which
 * option starts focused. Deriving either from the DTO's fields directly would
 * re-implement rules that already exist:
 *
 * - `permissionOptionsForRequest` suppresses always-allow whenever the request
 *   carries destructive warnings, even if `canAlwaysAllow` is true.
 * - `defaultPermissionIndex` focuses **deny** for those same requests.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export interface PermissionViewModel {
  readonly title: string
  readonly subtitle: string
  readonly reason: string
  readonly tone: PermissionTone
  readonly inputBlock: PermissionInputBlock
  readonly warnings: readonly DestructiveCommandWarning[]
  readonly denialStreakNote: string | undefined
  readonly options: readonly PermissionOption[]
  readonly selectedIndex: number
  readonly preview: PreviewView | undefined
  /** Labels of the other requests waiting, for the "Also waiting" line. */
  readonly alsoWaiting: readonly string[]
  readonly hint: string
}

/** How many other pending requests to name before summarising the rest. */
export const ALSO_WAITING_LIMIT = 3

export function initialPermissionIndex(request: PermissionRequestDto): number {
  return defaultPermissionIndex(request)
}

export function permissionViewModel(input: {
  request: PermissionRequestDto
  selectedIndex: number
  /** Position of this request among everything pending, for the subtitle. */
  activeIndex?: number
  total?: number
  others?: readonly PermissionRequestDto[]
}): PermissionViewModel {
  const { request } = input
  const warnings = destructiveWarningsForRequest(request)
  const options = permissionOptionsForRequest(request)
  const total = input.total ?? 1
  const activeIndex = input.activeIndex ?? 0

  return {
    title: formatPermissionTitle(request),
    // Already carries "n/m pending" when total > 1 — a view must not print a
    // second counter of its own.
    subtitle: formatPermissionSubtitle(request, activeIndex, total),
    reason: formatPermissionReason(request),
    tone: permissionToneForRequest(request, warnings),
    inputBlock: formatPermissionInputBlock(request),
    warnings,
    denialStreakNote: denialStreakNote(request.denialStreak),
    options,
    selectedIndex: clampIndex(input.selectedIndex, options.length),
    preview: request.preview ? previewView(request.preview) : undefined,
    alsoWaiting: alsoWaitingLabels(input.others ?? []),
    hint: hintFor(options, total),
  }
}

export type PermissionIntent =
  | { kind: 'move'; selectedIndex: number }
  | { kind: 'answer'; action: PermissionAction }
  | { kind: 'cycle'; direction: 'next' | 'prev' }
  | { kind: 'none' }

/**
 * A keystroke to an intent.
 *
 * Deliberately *not* given the DOM `KeyboardEvent` type: this module is imported
 * by a test, which compiles it in the base tsconfig program where there is no
 * DOM lib. The structural shape is what `bridgeChannel.ts` does for the same
 * reason.
 *
 * Escape answers `deny` rather than closing the dialog. There is no "close" — a
 * request left unanswered parks the agent loop, and the keymap therefore gives
 * an open dialog priority over interrupting the turn.
 */
export function permissionKeyToIntent(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  state: { selectedIndex: number; options: readonly PermissionOption[] },
): PermissionIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  const total = state.options.length

  switch (event.key) {
    case 'ArrowUp':
      return { kind: 'move', selectedIndex: nextPermissionIndex(state.selectedIndex, 'up', total) }
    case 'ArrowDown':
      return { kind: 'move', selectedIndex: nextPermissionIndex(state.selectedIndex, 'down', total) }
    case 'Tab':
      return { kind: 'cycle', direction: event.shiftKey === true ? 'prev' : 'next' }
    case 'Enter':
      return { kind: 'answer', action: resolvePermissionOption(state.selectedIndex, state.options).action }
    case 'Escape':
      return { kind: 'answer', action: 'deny' }
    default:
      break
  }

  const hotkey = event.key.toLowerCase()
  const match = state.options.find((option) => option.hotkey === hotkey)
  if (match) return { kind: 'answer', action: match.action }

  // Numeric shortcuts by slot, as every other dialog in this project offers.
  const slot = Number.parseInt(event.key, 10)
  if (!Number.isNaN(slot) && slot >= 1 && slot <= total) {
    return { kind: 'answer', action: state.options[slot - 1]!.action }
  }

  return { kind: 'none' }
}

/**
 * The wire answer for an action.
 *
 * `alwaysAllow` is only ever set here; the host fires `onAlwaysAllow` **before**
 * resolving the gate's promise, because `PermissionGate` reads the captured flag
 * on the statement right after its `await` returns.
 */
export function permissionResponseFor(action: PermissionAction): Extract<UiResponse, { kind: 'permission' }> {
  if (action === 'always') return { kind: 'permission', approved: true, alwaysAllow: true }
  return { kind: 'permission', approved: action === 'allow' }
}

function alsoWaitingLabels(others: readonly PermissionRequestDto[]): string[] {
  const labels = others.slice(0, ALSO_WAITING_LIMIT).map(formatPermissionRequestLabel)
  const rest = others.length - labels.length
  return rest > 0 ? [...labels, `+${rest} more`] : labels
}

/**
 * Surfaced because a streak means the agent is looping on something the user
 * keeps refusing, and the gate is about to start auto-denying.
 */
function denialStreakNote(denialStreak: number): string | undefined {
  if (denialStreak <= 0) return undefined
  return denialStreak === 1
    ? 'Denied once already.'
    : `Denied ${denialStreak} times already.`
}

function hintFor(options: readonly PermissionOption[], total: number): string {
  const keys = options.map((option) => option.hotkey.toUpperCase()).join('/')
  const base = `[↑↓] Move  [${keys}] Quick  [Enter] Select  [Esc] Deny`
  return total > 1 ? `${base}  [Tab] Next request` : base
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0
  if (index < 0) return 0
  return index > total - 1 ? total - 1 : index
}
