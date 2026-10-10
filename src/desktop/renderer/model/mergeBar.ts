import type { WireThreadMerge } from '../../shellProtocol.js'

/**
 * The merge reminder bar that sits above the composer (stage 5, T5).
 *
 * A thread canvas shows its own pending branch; a coordinator canvas shows a
 * summary of every thread branch waiting to be merged, which expands inline.
 * Pure and DOM-free: `dom/mergeBarView.ts` only turns this into nodes.
 *
 * Merging never goes through the model. The bar's intents are sent to the host,
 * which runs git directly and reports back through `WireThreadMerge.conflict`.
 */

export type MergeBarRole = 'thread' | 'coordinator'

export interface MergeBarEntry {
  readonly threadId: string
  readonly title: string
  readonly projectName: string
  readonly branch: string
  /** `+N −M`, with the Unicode minus the design uses for removed lines. */
  readonly stat: string
  readonly conflict: boolean
  readonly running: boolean
  readonly pending: boolean
  readonly mergeEnabled: boolean
  readonly resolveEnabled: boolean
}

export type MergeBarView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'single'; readonly entry: MergeBarEntry }
  | {
      readonly kind: 'summary'
      readonly label: string
      readonly expanded: boolean
      readonly entries: readonly MergeBarEntry[]
    }

export type MergeBarIntent =
  | { readonly kind: 'merge'; readonly threadId: string }
  | { readonly kind: 'resolve'; readonly threadId: string }
  | { readonly kind: 'dismiss'; readonly threadId: string }
  | { readonly kind: 'toggle-expanded' }

export function mergeStat(added: number, removed: number): string {
  return `+${added} −${removed}`
}

export function mergeSummaryLabel(count: number): string {
  return `${count} 个线程分支待合并`
}

export function mergeEntry(
  merge: WireThreadMerge,
  projectName: string,
  pending: ReadonlySet<string>,
): MergeBarEntry {
  const isPending = pending.has(merge.threadId)
  const idle = !merge.running && !isPending
  return {
    threadId: merge.threadId,
    title: merge.title,
    projectName,
    branch: merge.branch,
    stat: mergeStat(merge.added, merge.removed),
    conflict: merge.conflict,
    running: merge.running,
    pending: isPending,
    mergeEnabled: idle && !merge.conflict,
    resolveEnabled: idle && merge.conflict,
  }
}

/**
 * Chooses what the bar shows. `threadId` is only read for the `thread` role,
 * where a canvas with no pending branch of its own draws nothing at all.
 */
export function mergeBarView(input: {
  role: MergeBarRole
  threadId?: string
  projectName: string
  merges: readonly WireThreadMerge[]
  expanded: boolean
  /** Thread ids whose merge request is in flight. */
  pending: ReadonlySet<string>
}): MergeBarView {
  if (input.role === 'thread') {
    const own = input.merges.find((merge) => merge.threadId === input.threadId)
    if (!own) return { kind: 'hidden' }
    return { kind: 'single', entry: mergeEntry(own, input.projectName, input.pending) }
  }
  if (input.merges.length === 0) return { kind: 'hidden' }
  return {
    kind: 'summary',
    label: mergeSummaryLabel(input.merges.length),
    expanded: input.expanded,
    entries: input.merges.map((merge) => mergeEntry(merge, input.projectName, input.pending)),
  }
}
