import type {
  CheckpointDiffSummary,
  CheckpointWithDiff,
} from '../services/checkpoint/checkpointService.js'
import type { RewindSummaryDecision } from './rewindSummary.js'

/**
 * How `/rewind` is presented and what each decision actually does, independent
 * of any view.
 *
 * These were pure functions inside `RestoreMode.tsx` plus the decision
 * choreography inlined in `App.tsx`'s `handleRestoreSelect`. They live here for
 * the same reason `permissionPresentation.ts` and `planPresentation.ts` do: a
 * terminal panel and a DOM one must offer the *same* options in the same order
 * and report the same outcome in the same words, and rewind is destructive
 * enough that a second copy drifting is a data-loss bug rather than a cosmetic
 * one.
 *
 * Every cross-layer import here is type-only. `rewindSummary.ts` in particular
 * is a type-only import: it value-imports `node:crypto` and carries the whole
 * record-rewrite implementation, neither of which belongs in a renderer bundle.
 *
 * `RestoreMode.tsx` re-exports what it used to define, so existing importers and
 * tests are unaffected.
 */

export type RestoreDecision =
  | 'restore-code-and-conversation'
  | 'restore-conversation'
  | 'restore-code'
  | 'summarize-from-here'
  | 'summarize-up-to-here'
  | 'nevermind'

export interface RestoreOption {
  decision: RestoreDecision
  label: string
}

/**
 * The options for a checkpoint, in render order. Hotkeys are the 1-based index,
 * so this order *is* the numeric key mapping in both shells.
 *
 * A checkpoint whose restore would change no files loses the two code slots
 * rather than showing them inert — there is nothing to restore.
 */
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

/** The two decisions that are a summary rewrite rather than a rewind. */
export function isSummarizeDecision(decision: RestoreDecision): decision is RewindSummaryDecision {
  return decision === 'summarize-from-here' || decision === 'summarize-up-to-here'
}

// --- what a decision does ---------------------------------------------------

export type RewindStep = 'truncate' | 'restore-code' | 'summarize'

/**
 * The ordered side effects a decision performs.
 *
 * **The order for `restore-code-and-conversation` is load-bearing**: the
 * conversation is truncated first, and only then are the files reverted. That is
 * why `rewindPartialFailureMessage` exists at all — a git restore can fail after
 * the JSONL has already been cut, and the user has to be told which half landed.
 * Reversing the two would make that message describe the wrong state.
 *
 * `nevermind` performs nothing; it is the option that backs out of the confirm
 * screen, and a caller that runs it anyway does nothing rather than something
 * surprising.
 */
export function rewindStepsFor(decision: RestoreDecision): readonly RewindStep[] {
  switch (decision) {
    case 'restore-code-and-conversation':
      return ['truncate', 'restore-code']
    case 'restore-conversation':
      return ['truncate']
    case 'restore-code':
      return ['restore-code']
    case 'summarize-from-here':
    case 'summarize-up-to-here':
      return ['summarize']
    case 'nevermind':
      return []
  }
}

/** What the transcript says after a decision succeeded outright. */
export function rewindSuccessMessage(decision: RestoreDecision, preview: string): string {
  switch (decision) {
    case 'summarize-from-here':
      return `Summarized from "${preview}"`
    case 'summarize-up-to-here':
      return `Summarized up to before "${preview}"`
    case 'restore-conversation':
      return `Conversation rewound to before "${preview}"`
    case 'restore-code':
      return `Code restored to before "${preview}"`
    case 'restore-code-and-conversation':
      return `Code and conversation rewound to before "${preview}"`
    case 'nevermind':
      return ''
  }
}

/**
 * The one half-done outcome in the whole flow: the conversation was cut but the
 * files could not be reverted. Reported rather than thrown, because the
 * truncation is real and the user must not be told the rewind failed.
 */
export function rewindPartialFailureMessage(preview: string, error: string): string {
  return `Conversation rewound to before "${preview}", but file state could not be reverted: ${error}`
}

// --- formatting -------------------------------------------------------------

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

/**
 * The message preview both shells put inside the outcome messages above. Kept
 * next to them precisely because the quoted text has to match between shells.
 */
export function formatRestoreMessagePreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 50) return normalized
  return `${normalized.slice(0, 47)}...`
}

export function formatRelativeTime(isoTimestamp: string): string {
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
