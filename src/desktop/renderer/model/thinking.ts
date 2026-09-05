import { formatWorkedDuration } from './transcript.js'
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
 * The retired pre-T5 pair stored the *other* thing — a deviation from the
 * default — and that is exactly what stops working here. A deviation is only
 * meaningful against a static default (streaming = open, sealed = closed); against
 * 「am I the last step」 it inverts under the reader: collapse the running step by
 * hand, let the next step arrive, and the deviation re-opens the step the user just
 * shut. So a click records `expanded: true | false` and nothing recomputes it.
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
 * A thinking block that never joined a group — a record with no `turnId`.
 *
 * There is no 「current step」 for it to be, so the default is the static one this
 * file started with: open while it streams, closed once it is sealed. The answer
 * is still absolute, and it is stored in the same map under the block's own id.
 */
export function isLooseThinkingExpanded(item: TranscriptItem, state: DisclosureState = NO_DISCLOSURE): boolean {
  return state.get(item.id) ?? item.pending === true
}

/**
 * The group head (§5.3).
 *
 * It is the *collapsed* summary of a whole turn, so it deliberately does not name
 * what is happening right now — that belongs on the current step's head, because
 * the transcript is an `aria-live` region and a head tracking the activity would
 * be re-announced at every step (§8).
 */
export function groupHeaderLabel(group: ActivityGroup): string {
  // `stepCount` counts actions, so zero is a turn that only thought and answered.
  // 「0 步」 is not a fact worth a slot; the status alone carries that turn.
  const parts = [groupStatusLabel(group), ...(group.stepCount > 0 ? [`${group.stepCount} 步`] : [])]
  // Stated, not opened: a failure already opens its own step (§5.1), and forcing
  // the whole group open would move everything under it.
  if (group.failedCount > 0) parts.push(`${group.failedCount} 失败`)
  return parts.join(' · ')
}

/**
 * The group head's **accessible name** (§8), which is not its visible label.
 *
 * The label above is a live counter: `工作中 · 2 步` becomes `工作中 · 3 步` the
 * moment the next tool starts, and the transcript is an `aria-live="polite"`
 * region — so a name built from it would have a screen reader re-announce the
 * whole turn once per step, over the top of the step that actually is new.
 *
 * So a running group is named by its status alone, which does not change until
 * the turn ends. What changed belongs to the current step's own head, and the
 * counts stay in the visible label, which `dom/transcriptView.ts` hides from the
 * accessibility tree for the same reason the bead strip is hidden.
 *
 * A sealed group keeps the full label: it is written once, and the totals are
 * exactly what someone reading a finished turn wants read out.
 *
 * `live` is the session's own 「a turn is in flight」 (`model/waiting.ts` decides
 * which head carries it) and outranks `status`, which reads `done` in every gap
 * between two tool calls: a head whose name settled to 「已完成 · 2 步」 while the
 * turn was still working would announce the turn as over, repeatedly.
 */
export function groupHeaderName(group: ActivityGroup, live = false): string {
  return live || group.status === 'running' ? RUNNING_LABEL : groupHeaderLabel(group)
}

/** 「the turn is working」 — the running head's whole, unchanging name. */
const RUNNING_LABEL = '工作中'

function groupStatusLabel(group: ActivityGroup): string {
  if (group.status === 'running') return RUNNING_LABEL
  // An aborted turn has no measured time to quote — `turn-end` withholds the
  // duration line for it, and a record span would be a number nobody measured.
  if (group.status === 'aborted') return '已中断'
  return group.durationMs === undefined ? '已完成' : `已处理 ${formatWorkedDuration(group.durationMs)}`
}
