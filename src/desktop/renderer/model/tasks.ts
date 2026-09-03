import type { SessionRecord, TaskDisplayCounts, TaskDisplayItem, TaskDisplaySnapshot } from '../../../harness/types.js'
import { messageText } from './transcript.js'

/**
 * The task panel as data: the model's checklist, projected for the strip that
 * sits above the composer (`activity_group_design.md` §7).
 *
 * Session-level, not turn-level. The checklist says what happens *next*, so it
 * outlives the activity group that last touched it — which is also why the
 * source is a snapshot rather than an accumulation: the newest
 * `tool_result.display.taskSnapshot` is the whole truth, and recovering after a
 * pane switch or `/resume` is just a reverse scan of the records (§7.3).
 *
 * `transcript-reset` needs no special case here: the caller hands this the new
 * record list, and an empty list has no snapshot.
 *
 * DOM-free on purpose — `test/` imports this, and that puts it in the base
 * tsconfig program, which has no DOM lib.
 */

export interface TaskPanelItem {
  readonly id: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly subject: string
  /** What the row reads: `activeForm` while running, the subject otherwise. */
  readonly label: string
}

export interface TaskPanelState {
  readonly tasks: readonly TaskPanelItem[]
  readonly counts: TaskDisplayCounts
  /** The one `in_progress` task, if the model marked one. */
  readonly activeTask?: TaskPanelItem
  /** Completed share, 0..1 — the width of the 2px progress bar. */
  readonly ratio: number
  readonly allDone: boolean
}

/**
 * The panel's whole state, or `undefined` when there is no panel at all —
 * no snapshot yet, an empty checklist, or a finished checklist the user has
 * already moved past. The view draws nothing rather than a placeholder (§7.2).
 */
export function taskPanelState(records: readonly SessionRecord[]): TaskPanelState | undefined {
  const found = findLatestSnapshot(records)
  if (!found) return undefined

  const state = projectSnapshot(found.snapshot)
  if (!state) return undefined
  // A finished list survives exactly one more beat: it stays through the rest of
  // the turn so "did that actually finish?" has an answer, and the next user
  // message retires it (§7.3). An unfinished list is still the plan, so it stays.
  if (state.allDone && hasUserMessageAfter(records, found.index)) return undefined
  return state
}

/** Same projection from a snapshot already in hand (the live `tool_result`). */
export function taskPanelStateFromSnapshot(snapshot: TaskDisplaySnapshot | undefined): TaskPanelState | undefined {
  return snapshot ? projectSnapshot(snapshot) : undefined
}

/**
 * The panel after one more record — the live counterpart of `taskPanelState`.
 *
 * A pane sees records one at a time and never keeps the list, so the reverse
 * scan above is only affordable on the two paths that hand over a whole list
 * (`hello`, `transcript-reset`). This walks the same two rules forward instead:
 * a snapshot replaces the panel outright, and the user's next message retires a
 * finished one. Folding a session's records through this must land on what
 * `taskPanelState` says about the same records — `test/rendererTasks.test.ts`
 * asserts exactly that, because the two paths meet on every pane switch.
 */
export function advanceTaskPanel(
  current: TaskPanelState | undefined,
  record: SessionRecord,
): TaskPanelState | undefined {
  if (record.type === 'tool_result') {
    const snapshot = record.display?.taskSnapshot
    return snapshot ? taskPanelStateFromSnapshot(snapshot) : current
  }
  return current?.allDone && isRetiringUserMessage(record) ? undefined : current
}

/**
 * The user starting something new, which is what a finished checklist waits for
 * (§7.3). `turn-start` is the same moment seen a beat earlier — the user record
 * only lands after the turn's first I/O — so the pane retires on both and this
 * is what keeps the replay honest.
 */
export function retireCompletedTaskPanel(current: TaskPanelState | undefined): TaskPanelState | undefined {
  return current?.allDone ? undefined : current
}

function projectSnapshot(snapshot: TaskDisplaySnapshot): TaskPanelState | undefined {
  // `deleted` tasks ride along in the snapshot and are counted in its `total`
  // but nowhere else, so the panel counts its own rows instead of trusting
  // `snapshot.counts` — otherwise a deleted task holds the bar below full
  // forever.
  const tasks = snapshot.tasks.filter(isPanelTask).map(toPanelItem)
  if (tasks.length === 0) return undefined

  const counts = countPanelItems(tasks)
  const activeTask = tasks.find((task) => task.id === snapshot.activeTaskId && task.status === 'in_progress')
    ?? tasks.find((task) => task.status === 'in_progress')
  return {
    tasks,
    counts,
    ...(activeTask ? { activeTask } : {}),
    ratio: counts.completed / counts.total,
    allDone: counts.completed === counts.total,
  }
}

function findLatestSnapshot(
  records: readonly SessionRecord[],
): { readonly snapshot: TaskDisplaySnapshot; readonly index: number } | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.type !== 'tool_result') continue
    const snapshot = record.display?.taskSnapshot
    if (snapshot) return { snapshot, index }
  }
  return undefined
}

function hasUserMessageAfter(records: readonly SessionRecord[], index: number): boolean {
  for (let cursor = index + 1; cursor < records.length; cursor += 1) {
    const record = records[cursor]
    if (record && isRetiringUserMessage(record)) return true
  }
  return false
}

function isRetiringUserMessage(record: SessionRecord): boolean {
  if (record.type !== 'message' || record.role !== 'user') return false
  // A `<system-reminder>` user record is a model-facing nudge, not the user
  // starting something new — the transcript hides it, and so does this.
  return !isSystemReminderBlock(messageText(record))
}

function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

function isPanelTask(task: TaskDisplayItem): boolean {
  return task.status === 'pending' || task.status === 'in_progress' || task.status === 'completed'
}

function toPanelItem(task: TaskDisplayItem): TaskPanelItem {
  const status = task.status as TaskPanelItem['status']
  return {
    id: task.id,
    status,
    subject: task.subject,
    label: status === 'in_progress' && task.activeForm ? task.activeForm : task.subject,
  }
}

function countPanelItems(tasks: readonly TaskPanelItem[]): TaskDisplayCounts {
  const pending = tasks.filter((task) => task.status === 'pending').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    total: tasks.length,
    remaining: pending + inProgress,
    pending,
    inProgress,
    completed,
  }
}
