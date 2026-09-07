import type {
  CheckpointDiffSummary,
  CheckpointWithDiff,
} from '../services/fileHistory/types.js'
import { DEFAULT_LOCALE, type Locale } from './locale.js'
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
 * Every user-visible string in this module, per locale.
 *
 * The explicit interface plus `satisfies Record<Locale, …>` is what makes a
 * missing translation a *compile* error rather than an `undefined` on screen —
 * the same keyed-`satisfies` device `commandSchema.ts` uses to catch a new wire
 * variant by name.
 */
interface RewindStrings {
  readonly options: Record<RestoreDecision, string>
  readonly outcomes: Record<Exclude<RestoreDecision, 'nevermind'>, (preview: string) => string>
  readonly partialFailure: (preview: string, error: string) => string
  readonly unchanged: string
  readonly counts: (additions: number, deletions: number, where: string) => string
  readonly inFile: (file: string) => string
  readonly inFileAndOthers: (file: string, others: number) => string
  readonly acrossFiles: (count: number) => string
  readonly justNow: string
  readonly minutesAgo: (n: number) => string
  readonly hoursAgo: (n: number) => string
  readonly daysAgo: (n: number) => string
}

const STRINGS = {
  en: {
    options: {
      'restore-code-and-conversation': 'Restore code and conversation',
      'restore-conversation': 'Restore conversation',
      'restore-code': 'Restore code',
      'summarize-from-here': 'Summarize from here',
      'summarize-up-to-here': 'Summarize up to here',
      nevermind: 'Never mind',
    },
    outcomes: {
      'summarize-from-here': (preview) => `Summarized from "${preview}"`,
      'summarize-up-to-here': (preview) => `Summarized up to before "${preview}"`,
      'restore-conversation': (preview) => `Conversation rewound to before "${preview}"`,
      'restore-code': (preview) => `Code restored to before "${preview}"`,
      'restore-code-and-conversation': (preview) =>
        `Code and conversation rewound to before "${preview}"`,
    },
    partialFailure: (preview, error) =>
      `Conversation rewound to before "${preview}", but file state could not be reverted: ${error}`,
    unchanged: 'unchanged',
    counts: (additions, deletions, where) => `+${additions} -${deletions} ${where}`,
    inFile: (file) => `in ${file}`,
    inFileAndOthers: (file, others) =>
      `in ${file} and ${others} other ${others === 1 ? 'file' : 'files'}`,
    acrossFiles: (count) => `across ${count} ${count === 1 ? 'file' : 'files'}`,
    justNow: 'just now',
    minutesAgo: (n) => `${n}m ago`,
    hoursAgo: (n) => `${n}h ago`,
    daysAgo: (n) => `${n}d ago`,
  },
  zh: {
    options: {
      'restore-code-and-conversation': '恢复代码与对话',
      'restore-conversation': '恢复对话',
      'restore-code': '恢复代码',
      'summarize-from-here': '从此处开始摘要',
      'summarize-up-to-here': '摘要到此处之前',
      nevermind: '算了',
    },
    outcomes: {
      'summarize-from-here': (preview) => `已从“${preview}”开始摘要`,
      'summarize-up-to-here': (preview) => `已摘要到“${preview}”之前`,
      'restore-conversation': (preview) => `对话已回退到“${preview}”之前`,
      'restore-code': (preview) => `代码已恢复到“${preview}”之前`,
      'restore-code-and-conversation': (preview) => `代码与对话已回退到“${preview}”之前`,
    },
    partialFailure: (preview, error) =>
      `对话已回退到“${preview}”之前，但文件状态无法还原：${error}`,
    unchanged: '无改动',
    counts: (additions, deletions, where) => `+${additions} -${deletions} ${where}`,
    inFile: (file) => `位于 ${file}`,
    inFileAndOthers: (file, others) => `位于 ${file} 及另外 ${others} 个文件`,
    acrossFiles: (count) => `共 ${count} 个文件`,
    justNow: '刚刚',
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
  },
} as const satisfies Record<Locale, RewindStrings>

/**
 * The options for a checkpoint, in render order. Hotkeys are the 1-based index,
 * so this order *is* the numeric key mapping in both shells.
 *
 * A checkpoint whose restore would change no files loses the two code slots
 * rather than showing them inert — there is nothing to restore.
 */
export function buildRestoreOptions(
  hasCodeChanges: boolean,
  locale: Locale = DEFAULT_LOCALE,
): readonly RestoreOption[] {
  const labels = STRINGS[locale].options
  const option = (decision: RestoreDecision): RestoreOption => ({
    decision,
    label: labels[decision],
  })
  const conversationOnly: RestoreOption[] = [
    option('restore-conversation'),
    option('summarize-from-here'),
    option('summarize-up-to-here'),
    option('nevermind'),
  ]
  if (!hasCodeChanges) return conversationOnly
  return [
    option('restore-code-and-conversation'),
    option('restore-conversation'),
    option('restore-code'),
    option('summarize-from-here'),
    option('summarize-up-to-here'),
    option('nevermind'),
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
export function rewindSuccessMessage(
  decision: RestoreDecision,
  preview: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (decision === 'nevermind') return ''
  return STRINGS[locale].outcomes[decision](preview)
}

/**
 * The one half-done outcome in the whole flow: the conversation was cut but the
 * files could not be reverted. Reported rather than thrown, because the
 * truncation is real and the user must not be told the rewind failed.
 */
export function rewindPartialFailureMessage(
  preview: string,
  error: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return STRINGS[locale].partialFailure(preview, error)
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

export function formatDiffSummary(
  summary: CheckpointDiffSummary,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const strings = STRINGS[locale]
  if (!summary.hasChanges) return strings.unchanged
  const where = summary.firstFile
    ? summary.fileCount > 1
      ? strings.inFileAndOthers(summary.firstFile, summary.fileCount - 1)
      : strings.inFile(summary.firstFile)
    : strings.acrossFiles(summary.fileCount)
  return strings.counts(summary.additions, summary.deletions, where)
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

export function formatRelativeTime(
  isoTimestamp: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const timestamp = new Date(isoTimestamp).getTime()
  if (!Number.isFinite(timestamp)) return isoTimestamp
  const strings = STRINGS[locale]
  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (elapsedMs < minuteMs) return strings.justNow
  if (elapsedMs < hourMs) return strings.minutesAgo(Math.floor(elapsedMs / minuteMs))
  if (elapsedMs < dayMs) return strings.hoursAgo(Math.floor(elapsedMs / hourMs))
  return strings.daysAgo(Math.floor(elapsedMs / dayMs))
}
