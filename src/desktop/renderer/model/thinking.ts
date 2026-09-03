import type { ActivityGroup, ActivityStep, TranscriptEntry, TranscriptItem } from './transcript.js'

/**
 * Which activity groups and steps are open, as pure decisions (§5).
 *
 * Two halves, and the split is the whole point:
 *
 * - a **dynamic default** (§5.1), which is what the reader gets for free — the
 *   running turn's group is open, only its current step is open, and once the turn
 *   ends everything collapses except what failed;
 * - the user's **absolute** answer for anything they clicked (§5.2), which from
 *   then on outranks the default entirely.
 *
 * `isThinkingCollapsed` below stores the *other* thing — a deviation from the
 * default — and that is exactly what stops working here. A deviation is only
 * meaningful against a static default (streaming = open, sealed = closed); against
 * 「am I the last step」 it inverts under the reader: collapse the running step by
 * hand, let the next step arrive, and the deviation re-opens the step the user just
 * shut. So a click records `expanded: true | false` and nothing recomputes it.
 *
 * Both APIs live here while T7/T10 move the view over; the deviation pair goes
 * away with its last caller.
 *
 * DOM-free, like everything in `model/`.
 */

/** While the block is still arriving. */
export const THINKING_LIVE_LABEL = '正在思考'
/** A sealed block with no elapsed time — an aborted turn never produced one. */
export const THINKING_DONE_FALLBACK = '思考过程'

/**
 * The header of a thinking block, whether it arrived as a loose item or as a step.
 *
 * Both shapes carry the same two fields, so the label takes the fields rather than
 * either type — a thinking `ActivityStep` is a projection of the item it came from.
 */
export function thinkingHeaderLabel(block: { readonly pending?: boolean; readonly summary?: string }): string {
  if (block.pending === true) return THINKING_LIVE_LABEL
  return block.summary ?? THINKING_DONE_FALLBACK
}

/**
 * What the user decided by hand, by group id (`turnId`) or step id. Absent = the
 * default still rules.
 */
export type DisclosureState = ReadonlyMap<string, boolean>

export const NO_DISCLOSURE: DisclosureState = new Map()

/**
 * A step whose body is a disclosure at all.
 *
 * Staged prose is shown whole (§4.4), a `TodoWrite` line's list lives in the task
 * panel (§7), and a system notice is its own single line — none of the three has a
 * body to open, so none of them may consume a click or a toggle entry.
 */
export function isStepCollapsible(step: ActivityStep): boolean {
  return step.kind === 'thinking' || step.kind === 'tool' || step.kind === 'subagent'
}

/** The group's own disclosure: open while the turn runs, closed once it is over. */
export function isGroupExpanded(group: ActivityGroup, state: DisclosureState = NO_DISCLOSURE): boolean {
  return state.get(group.turnId) ?? group.status === 'running'
}

/**
 * A step's disclosure, by position in its group — the position *is* the default
 * (§5.1), which is why this takes the group and an index rather than a step.
 */
export function isStepExpanded(
  group: ActivityGroup,
  index: number,
  state: DisclosureState = NO_DISCLOSURE,
): boolean {
  const step = group.steps[index]
  if (step === undefined) return false
  if (!isStepCollapsible(step)) return true
  return state.get(step.id) ?? defaultStepExpanded(group, index, step)
}

function defaultStepExpanded(group: ActivityGroup, index: number, step: ActivityStep): boolean {
  // A failure is the reason someone opens a finished group at all (§5.1), so it
  // opens itself — in a running turn just as much as in a sealed one, because a
  // failed step scrolling past unopened is the case this whole screen exists for.
  if (isStepFailed(step)) return true
  // The permission request is drawn in the composer and that is where the user is
  // looking; unfolding a diff up here would take the focus back (§5.1).
  if ('status' in step && step.status === 'awaiting-approval') return false
  return group.status === 'running' && index === group.steps.length - 1
}

/** The same predicate `groupTranscript` counts with, so head and body agree. */
function isStepFailed(step: ActivityStep): boolean {
  return ('status' in step && step.status === 'failed') || ('failed' in step && step.failed === true)
}

/**
 * Records the user's answer for `id` as an absolute value.
 *
 * `expanded` is what the row shows **now**, so the first click always does the
 * visible thing whether or not a default was in force.
 */
export function toggleDisclosure(state: DisclosureState, id: string, expanded: boolean): DisclosureState {
  const next = new Map(state)
  next.set(id, !expanded)
  return next
}

/**
 * Drops answers for groups and steps that no longer exist.
 *
 * The same necessity `pruneThinkingToggles` had, unchanged by the new shape: a
 * `transcript-reset` rebuilds the state with `thinkingCount` back at zero, so the
 * next block reuses `thinking-0` and would inherit a *different* block's answer —
 * and now a stale answer is absolute, so it would not even be corrected by the
 * default.
 */
export function pruneDisclosure(entries: readonly TranscriptEntry[], state: DisclosureState): DisclosureState {
  const live = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'group') {
      live.add(entry.group.turnId)
      for (const step of entry.group.steps) live.add(step.id)
    } else if (entry.item.kind === 'thinking') {
      // A thinking block from a record with no `turnId` never joins a group, and
      // it is still a disclosure the user can have answered.
      live.add(entry.item.id)
    }
  }
  const next = new Map<string, boolean>()
  for (const [id, expanded] of state) {
    if (live.has(id)) next.set(id, expanded)
  }
  return next
}

/**
 * The pre-T5 disclosure: `toggled` records **disagreement with the default**.
 *
 * Sound for the one static default it was written against (「还在流就展开，封存了就
 * 折叠」), and kept only until `transcriptView.ts` and `paneSession.ts` move to
 * `isStepExpanded` (T7, T10). New callers must not use it — see this module's
 * header for why the deviation inverts under a dynamic default.
 */
export function isThinkingCollapsed(item: TranscriptItem, toggled: ReadonlySet<string>): boolean {
  const collapsedByDefault = item.pending !== true
  return toggled.has(item.id) ? !collapsedByDefault : collapsedByDefault
}

/** `pruneDisclosure`'s predecessor, over the flat item list. Retired with T10. */
export function pruneThinkingToggles(
  items: readonly TranscriptItem[],
  toggled: ReadonlySet<string>,
): Set<string> {
  const live = new Set(items.filter((item) => item.kind === 'thinking').map((item) => item.id))
  return new Set([...toggled].filter((id) => live.has(id)))
}
