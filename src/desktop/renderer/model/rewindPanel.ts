import {
  buildRestoreOptions,
  formatDiffSummary,
  formatRelativeTime,
  formatRestoreMessagePreview,
  isSummarizeDecision,
  rewindPartialFailureMessage,
  rewindStepsFor,
  rewindSuccessMessage,
  sortCheckpointsChronological,
  truncateMessage,
  type RestoreDecision,
  type RestoreOption,
} from '../../../runtime/rewindPresentation.js'
import type { CheckpointWithDiff } from '../../../services/checkpoint/checkpointService.js'
import type { RewindSummaryDecision } from '../../../runtime/rewindSummary.js'

/**
 * The `/rewind` panel: pick a checkpoint, confirm what to undo, run it.
 *
 * Two screens rather than one, because every option here is destructive and one
 * of them spends a real provider call. Which options exist, in what order, and
 * what the transcript says afterwards all come from
 * `runtime/rewindPresentation.ts` — shared with `RestoreMode.tsx` so the two
 * shells cannot drift on a data-losing decision.
 *
 * The panel is modal but *not* a `UiRequest`: nothing in the agent loop is
 * waiting on it, so `keymap.ts` ranks it below the four blocking dialogs. A
 * permission prompt parks the loop; this only parks the user.
 *
 * DOM-free on purpose — this module is imported by a test, which compiles it in
 * the base tsconfig program where there is no DOM lib. Hence the structural key
 * shape and the structural `RewindClient` below rather than `KeyboardEvent` and
 * `SessionClient`.
 */

export type RewindScreen = 'select' | 'confirm'

export interface RewindState {
  /** Chronological, oldest first, the way `RestoreMode` lists them. */
  readonly checkpoints: readonly CheckpointWithDiff[]
  readonly screen: RewindScreen
  /**
   * `=== checkpoints.length` means the synthetic "(current)" row, which is where
   * a freshly opened panel sits — the same starting point as the terminal's, so
   * an accidental Enter closes the panel instead of arming a rewind.
   */
  readonly checkpointIndex: number
  readonly optionIndex: number
  /** A decision is running. The panel keeps drawing, but takes no input. */
  readonly busy: boolean
  readonly error?: string
}

export function createRewindState(checkpoints: readonly CheckpointWithDiff[]): RewindState {
  const sorted = sortCheckpointsChronological([...checkpoints])
  return {
    checkpoints: sorted,
    screen: 'select',
    checkpointIndex: sorted.length,
    optionIndex: 0,
    busy: false,
  }
}

/** The checkpoint the cursor is on, or undefined on the "(current)" row. */
export function selectedCheckpoint(state: RewindState): CheckpointWithDiff | undefined {
  if (state.checkpointIndex >= state.checkpoints.length) return undefined
  return state.checkpoints[state.checkpointIndex]
}

// --- view model -------------------------------------------------------------

export interface RewindRow {
  /** `messageId`, because commit hashes can repeat. `'current'` for the last row. */
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly selected: boolean
  /** The synthetic "(current)" row, which cancels rather than rewinds. */
  readonly isCurrent: boolean
}

export interface RewindOptionRow {
  readonly decision: RestoreDecision
  readonly label: string
  readonly hotkey: string
  readonly selected: boolean
}

export interface RewindViewModel {
  readonly screen: RewindScreen
  readonly title: string
  readonly subtitle: string
  readonly rows: readonly RewindRow[]
  readonly options: readonly RewindOptionRow[]
  /** The chosen checkpoint's message, verbatim except for length. */
  readonly messagePreview: string
  readonly timeLabel: string
  readonly codeEffect: string
  readonly warning?: string
  readonly emptyMessage?: string
  readonly busyLabel?: string
  readonly error?: string
  readonly hint: string
}

const MESSAGE_ROW_WIDTH = 88
const CONFIRM_MESSAGE_WIDTH = 100

export function rewindViewModel(state: RewindState): RewindViewModel {
  const checkpoint = selectedCheckpoint(state)

  if (state.checkpoints.length === 0) {
    return {
      screen: 'select',
      title: 'Rewind',
      subtitle: 'Return to an earlier point in this session.',
      rows: [],
      options: [],
      messagePreview: '',
      timeLabel: '',
      codeEffect: '',
      emptyMessage: 'No checkpoints available',
      ...(state.error === undefined ? {} : { error: state.error }),
      hint: '[Esc] Close',
    }
  }

  if (state.screen === 'select') {
    return {
      screen: 'select',
      title: 'Rewind',
      subtitle: 'Restore the code and/or conversation to the point before...',
      rows: [
        ...state.checkpoints.map((entry, index) => ({
          id: entry.messageId,
          label: truncateMessage(entry.messageContent.replace(/\s+/g, ' '), MESSAGE_ROW_WIDTH)
            || '(no message)',
          detail: diffRowDetail(entry),
          selected: index === state.checkpointIndex,
          isCurrent: false,
        })),
        {
          id: 'current',
          label: '(current)',
          detail: '',
          selected: state.checkpointIndex >= state.checkpoints.length,
          isCurrent: true,
        },
      ],
      options: [],
      messagePreview: '',
      timeLabel: '',
      codeEffect: '',
      ...(state.error === undefined ? {} : { error: state.error }),
      hint: '[↑↓] Move  [Enter] Select  [Esc] Close',
    }
  }

  const options = buildRestoreOptions(checkpoint?.restoreDiff.hasChanges === true)
  const selectedIndex = clamp(state.optionIndex, 0, options.length - 1)
  const hasCodeChanges = checkpoint?.restoreDiff.hasChanges === true

  return {
    screen: 'confirm',
    title: 'Confirm you want to restore to the point before you sent this message:',
    subtitle: 'The conversation will be forked.',
    rows: [],
    options: options.map((option, index) => ({
      decision: option.decision,
      label: option.label,
      hotkey: String(index + 1),
      selected: index === selectedIndex,
    })),
    messagePreview: checkpoint
      ? truncateMessage(checkpoint.messageContent, CONFIRM_MESSAGE_WIDTH) || '(no message)'
      : '(no message)',
    timeLabel: checkpoint ? formatRelativeTime(checkpoint.timestamp) : '',
    codeEffect: hasCodeChanges && checkpoint
      ? `The code will be restored ${formatDiffSummary(checkpoint.restoreDiff)}.`
      : 'The code will be unchanged.',
    ...(hasCodeChanges
      ? { warning: 'Warning: Rewinding does not affect files edited manually or via bash.' }
      : {}),
    ...(state.busy ? { busyLabel: busyLabelFor(options[selectedIndex]) } : {}),
    ...(state.error === undefined ? {} : { error: state.error }),
    hint: `[↑↓] Move  [1–${options.length}] Choose  [Enter] Confirm  [Esc] Back`,
  }
}

function diffRowDetail(checkpoint: CheckpointWithDiff): string {
  const summary = checkpoint.turnDiff
  if (!summary.hasChanges) return 'No code changes'
  const files = `${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'} changed`
  return `${files} +${summary.additions} -${summary.deletions}`
}

function busyLabelFor(option: RestoreOption | undefined): string {
  if (option && isSummarizeDecision(option.decision)) return 'Summarizing...'
  return 'Rewinding...'
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

// --- keys -------------------------------------------------------------------

export interface RewindChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

export type RewindIntent =
  | { readonly kind: 'move'; readonly direction: 'up' | 'down' }
  | { readonly kind: 'open-confirm' }
  /** Address a row directly, which is what a click has. */
  | { readonly kind: 'select-row'; readonly id: string }
  | { readonly kind: 'choose'; readonly decision: RestoreDecision }
  | { readonly kind: 'back' }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' }

export function rewindKeyToIntent(chord: RewindChord, state: RewindState): RewindIntent {
  // A decision is mid-flight: files are being reverted or a summary is being
  // generated. Taking a second one would race the first.
  if (state.busy) return { kind: 'none' }
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }

  if (chord.key === 'Escape') {
    // Escape backs out one screen at a time, so a mis-picked checkpoint costs
    // one keystroke rather than reopening the panel.
    return state.screen === 'confirm' ? { kind: 'back' } : { kind: 'close' }
  }

  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }

  if (state.screen === 'select') {
    if (chord.key === 'Enter') return { kind: 'open-confirm' }
    return { kind: 'none' }
  }

  const options = buildRestoreOptions(selectedCheckpoint(state)?.restoreDiff.hasChanges === true)
  if (chord.key === 'Enter') {
    const option = options[clamp(state.optionIndex, 0, options.length - 1)]
    return option ? { kind: 'choose', decision: option.decision } : { kind: 'none' }
  }

  const slot = Number.parseInt(chord.key, 10)
  if (!Number.isNaN(slot) && slot >= 1 && slot <= options.length) {
    const option = options[slot - 1]
    if (option) return { kind: 'choose', decision: option.decision }
  }

  return { kind: 'none' }
}

// --- transitions ------------------------------------------------------------

/** What the caller has to do, if anything, after applying an intent. */
export interface RewindRun {
  readonly decision: RestoreDecision
  readonly checkpoint: CheckpointWithDiff
}

export type RewindOutcome =
  | { readonly state: RewindState }
  | { readonly state: RewindState; readonly run: RewindRun }
  | { readonly state: RewindState; readonly close: true }

export function applyRewindIntent(state: RewindState, intent: RewindIntent): RewindOutcome {
  switch (intent.kind) {
    case 'move':
      return { state: moveSelection(state, intent.direction) }

    case 'select-row': {
      if (intent.id === 'current') return { state, close: true }
      const index = state.checkpoints.findIndex((entry) => entry.messageId === intent.id)
      if (index < 0) return { state }
      return {
        state: { ...state, checkpointIndex: index, screen: 'confirm', optionIndex: 0, error: undefined },
      }
    }

    case 'open-confirm': {
      // Enter on "(current)" means "never mind" — there is nothing before now to
      // rewind to. `RestoreMode` treats it the same way.
      if (!selectedCheckpoint(state)) return { state, close: true }
      return { state: { ...state, screen: 'confirm', optionIndex: 0, error: undefined } }
    }

    case 'choose': {
      const checkpoint = selectedCheckpoint(state)
      if (!checkpoint) return { state }
      const optionIndex = optionIndexOf(state, intent.decision)
      // "Never mind" is the back affordance in option form; it performs nothing.
      if (intent.decision === 'nevermind') {
        return { state: { ...state, screen: 'select', optionIndex: 0, error: undefined } }
      }
      return {
        state: { ...state, optionIndex, error: undefined },
        run: { decision: intent.decision, checkpoint },
      }
    }

    case 'back':
      return { state: { ...state, screen: 'select', optionIndex: 0, error: undefined } }

    case 'close':
      return { state, close: true }

    case 'none':
      return { state }
  }
}

function moveSelection(state: RewindState, direction: 'up' | 'down'): RewindState {
  if (state.screen === 'select') {
    // Clamped rather than wrapping: the list is a timeline, and wrapping from
    // "(current)" to the oldest checkpoint reads as a glitch.
    const last = state.checkpoints.length
    const next = clamp(state.checkpointIndex + (direction === 'up' ? -1 : 1), 0, last)
    return { ...state, checkpointIndex: next }
  }
  const options = buildRestoreOptions(selectedCheckpoint(state)?.restoreDiff.hasChanges === true)
  const next = clamp(state.optionIndex + (direction === 'up' ? -1 : 1), 0, options.length - 1)
  return { ...state, optionIndex: next }
}

function optionIndexOf(state: RewindState, decision: RestoreDecision): number {
  const options = buildRestoreOptions(selectedCheckpoint(state)?.restoreDiff.hasChanges === true)
  const index = options.findIndex((option) => option.decision === decision)
  return index < 0 ? state.optionIndex : index
}

export function beginRewindRun(state: RewindState): RewindState {
  return { ...state, busy: true, error: undefined }
}

export function failRewindRun(state: RewindState, message: string): RewindState {
  // Back on the confirm screen with the reason shown: the user picked one of
  // several options and may want a different one.
  return { ...state, busy: false, error: message }
}

// --- running a decision -----------------------------------------------------

/**
 * The slice of `SessionClient` a rewind needs, structurally so a test can pass a
 * stub and so this module stays out of `protocol/client.js`.
 */
export interface RewindClient {
  truncateSession(messageId: string): Promise<unknown>
  restoreCode(commitHash: string): Promise<{ success: boolean; error?: string }>
  summarizeRewind(messageId: string, decision: RewindSummaryDecision): Promise<unknown>
}

export interface RewindResult {
  readonly message: string
  /** The conversation was cut but the files were not reverted. */
  readonly partial: boolean
}

/**
 * Executes a decision as the ordered steps `rewindStepsFor` names.
 *
 * Two asymmetries are deliberate and both come from the host:
 *
 * - `truncate-session` *throws* for a message it cannot find, so a stale
 *   checkpoint list surfaces as an error rather than a silent no-op.
 * - `restore-code` *reports* `{ success: false }` instead of throwing, so this
 *   has to convert — otherwise a failed git restore reads as a success.
 *
 * Neither the transcript nor the record ledger is rebuilt here: the host's
 * `afterRewind()` already pushed a `transcript-reset`, and folding the reply's
 * records in again would repaint twice.
 */
export async function runRewind(
  client: RewindClient,
  decision: RestoreDecision,
  checkpoint: CheckpointWithDiff,
): Promise<RewindResult> {
  const preview = formatRestoreMessagePreview(checkpoint.messageContent)
  let truncated = false

  for (const step of rewindStepsFor(decision)) {
    if (step === 'truncate') {
      await client.truncateSession(checkpoint.messageId)
      truncated = true
      continue
    }

    if (step === 'summarize') {
      if (!isSummarizeDecision(decision)) continue
      await client.summarizeRewind(checkpoint.messageId, decision)
      continue
    }

    const restored = await client.restoreCode(checkpoint.commitHash)
    if (restored.success) continue
    const reason = restored.error ?? 'Failed to restore file state'
    // Only half-done if the conversation was already cut; on its own this is a
    // plain failure and the caller shows it in the panel.
    if (!truncated) throw new Error(reason)
    return { message: rewindPartialFailureMessage(preview, reason), partial: true }
  }

  return { message: rewindSuccessMessage(decision, preview), partial: false }
}
