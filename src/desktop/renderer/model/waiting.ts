import {
  formatWorkedDuration,
  type ActivityGroup,
  type ActivityStep,
  type TranscriptEntry,
  type TranscriptItem,
} from './transcript.js'

/**
 * What the turn is doing **right now**, and where that is said.
 *
 * The rule is one line: the live status belongs at the *top* of the turn, on the
 * activity group's own head, and it stays there while the turn runs. It was a
 * row at the tail of the transcript before, which meant 「正在思考」 walked down
 * the page behind every thought and every tool call — the one label whose job is
 * to be found without looking was the one that never sat still.
 *
 * So there are two carriers of one status:
 *
 * - the **group head** (`liveGroupId`), for a turn that has already produced a
 *   step. `groupActivityLabel` is what it reads: the running tool's own name, or
 *   「正在思考」 when nothing is running and the model is deciding. It seals to
 *   `groupHeaderLabel`'s 「已处理 …」 when the turn ends, and only then.
 * - the standalone **row** (`row`), for the gap before the first step, when
 *   there is no group yet to head. That gap is the one between pressing Enter
 *   and the first record, and it is the whole reason this file exists: the shell
 *   says 「生成中」 under the composer, but the reader is looking at the end of
 *   the transcript, where a slow first token left an empty page.
 *
 * Never both, and never a second voice beside a growing draft: if the tail is
 * visibly arriving and no group has been opened, nothing is drawn.
 *
 * DOM-free, like every other `model/` unit: the clock lives in the view, and
 * `startedAt` is only carried through so a test can pin the contents without one.
 */

/** 「正在思考」 — the label for 「the model is deciding」, wherever it is shown. */
export const WAITING_LABEL = '正在思考'

/**
 * `Esc` is a real binding here, not a decoration: `model/keymap.ts` maps it to
 * `interrupt` whenever a turn is streaming and no dialog outranks it. A dialog
 * *does* outrank it — but a dialog is a request, and a request parks the turn on
 * a pending step, which is a state this hint is never drawn in.
 */
export const WAITING_HINT = 'Esc 中断'

export interface WaitingInput {
  /** The session snapshot's own flag: a turn is in flight. */
  readonly isStreaming: boolean
  /** When this turn started, epoch ms. The view counts up from it. */
  readonly startedAt: number | undefined
  /** The turn whose records are arriving (`TranscriptState.turnId`). */
  readonly turnId: string | undefined
}

export interface WaitingRow {
  readonly label: string
  readonly hint: string
  readonly startedAt: number | undefined
}

export interface TurnActivity {
  /** The group whose head carries the live status, by `turnId`. */
  readonly liveGroupId: string | undefined
  /** The standalone row, drawn only when no group has been opened yet. */
  readonly row: WaitingRow | undefined
}

const IDLE: TurnActivity = { liveGroupId: undefined, row: undefined }

/**
 * How long the gap has to last before the counter is worth showing.
 *
 * A turn that answers in two seconds does not need to be timed, and a number
 * that appears with the row and is gone again before it can be read is noise
 * next to the label. Past five seconds the wait is the thing the reader is
 * actually looking at, and how long it has been is the answer they want.
 */
export const WAITING_CLOCK_AFTER_MS = 5_000

/**
 * What the counter reads at `elapsedMs` — the empty string while the wait is
 * still short, which is how the view says 「no counter yet」 without a second
 * piece of state. The threshold lives here rather than in the clock because it
 * is a decision, and the view's timer is not where decisions go.
 */
export function waitingElapsedLabel(elapsedMs: number): string {
  return elapsedMs < WAITING_CLOCK_AFTER_MS ? '' : formatWorkedDuration(elapsedMs)
}

/**
 * Which carrier says it, for this paint.
 *
 * `entries` is what the view is about to draw, so head and row can never both
 * claim the status. The live group is found by the state's own `turnId` rather
 * than by 「the last group」: a new turn that has not produced a record yet has no
 * `turnId` at all, and the group above it belongs to the turn before — lighting
 * *that* head up would report the wrong turn as running.
 *
 * `ActivityGroup.status` is deliberately not consulted either. It reads 「done」
 * the moment the last tool result merges in, which happens several times inside
 * a turn that is still very much running; the session's own `isStreaming` is the
 * only honest source for 「the turn is over」. An aborted group is the exception
 * it looks like: the interruption is already in the transcript, and its head
 * says 已中断.
 */
export function turnActivity(entries: readonly TranscriptEntry[], input: WaitingInput): TurnActivity {
  if (!input.isStreaming) return IDLE
  const group = liveGroup(entries, input.turnId)
  if (group !== undefined) return { liveGroupId: group.turnId, row: undefined }
  const last = entries[entries.length - 1]
  if (last !== undefined && last.kind === 'item' && isArriving(last.item)) return IDLE
  return { liveGroupId: undefined, row: { label: WAITING_LABEL, hint: WAITING_HINT, startedAt: input.startedAt } }
}

function liveGroup(entries: readonly TranscriptEntry[], turnId: string | undefined): ActivityGroup | undefined {
  if (turnId === undefined) return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind !== 'group' || entry.group.turnId !== turnId) continue
    return entry.group.status === 'aborted' ? undefined : entry.group
  }
  return undefined
}

/**
 * The live head's label: the running tool's name, else 「正在思考」.
 *
 * The *name* only — not the call's arguments. A head that is read to find out
 * what is happening wants one word, and the command it ran is one line below,
 * on the step's own head, where it can be opened.
 *
 * The last pending action wins, because a batch's calls settle in order and the
 * one still open is the one being waited on. A pending *thinking* step is not an
 * action and needs no name of its own: 「正在思考」 is already what it would say.
 */
export function groupActivityLabel(group: ActivityGroup): string {
  for (let index = group.steps.length - 1; index >= 0; index -= 1) {
    const name = pendingActionName(group.steps[index]!)
    if (name !== undefined) return name
  }
  return WAITING_LABEL
}

function pendingActionName(step: ActivityStep): string | undefined {
  if (step.kind === 'tool' || step.kind === 'task') {
    if (step.pending !== true) return undefined
    const name = step.tool.displayName.length > 0 ? step.tool.displayName : step.toolName
    return name === undefined || name.length === 0 ? undefined : name
  }
  if (step.kind === 'subagent') return step.pending === true ? step.text : undefined
  return undefined
}

/**
 * Whether the transcript's last loose item is visibly still coming.
 *
 * A pending message or thinking segment only says so once it has text:
 * `text_delta` can open a draft with an empty string, and an empty bubble is
 * exactly the blank page the row exists for.
 */
function isArriving(item: TranscriptItem): boolean {
  if (item.pending !== true) return false
  if (item.kind === 'tool' || item.kind === 'subagent') return true
  return item.text.trim().length > 0
}
