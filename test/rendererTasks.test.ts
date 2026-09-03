import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceTaskPanel,
  retireCompletedTaskPanel,
  taskPanelState,
  taskPanelStateFromSnapshot,
  type TaskPanelState,
} from '../src/desktop/renderer/model/tasks.js'
import type { SessionRecord, TaskDisplayItem, TaskDisplaySnapshot } from '../src/harness/types.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'

/**
 * The task panel's view model (`activity_group_design.md` §7.3).
 *
 * The panel is session-level, so everything it knows comes from a reverse scan
 * for the newest `taskSnapshot` — that is the same recovery path a pane switch
 * and `/resume` take, which is why these tests only ever hand it a record list.
 */

function task(id: string, status: TaskDisplayItem['status'], subject: string, activeForm?: string): TaskDisplayItem {
  return {
    id,
    status,
    subject,
    description: subject,
    ...(activeForm ? { activeForm } : {}),
    blocks: [],
    blockedBy: [],
  }
}

function snapshot(tasks: TaskDisplayItem[], activeTaskId?: string): TaskDisplaySnapshot {
  const pending = tasks.filter((t) => t.status === 'pending').length
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const completed = tasks.filter((t) => t.status === 'completed').length
  return {
    tasks,
    counts: { total: tasks.length, remaining: pending + inProgress, pending, inProgress, completed },
    ...(activeTaskId ? { activeTaskId } : {}),
  }
}

function todoWrite(id: string, snap: TaskDisplaySnapshot): SessionRecord {
  return {
    type: 'tool_result',
    id,
    toolUseId: `use-${id}`,
    tool: 'TodoWrite',
    ok: true,
    content: 'updated',
    createdAt: 'now',
    display: { summary: '更新任务清单', taskSnapshot: snap },
  }
}

function message(id: string, role: 'user' | 'assistant', content: string): SessionRecord {
  return { type: 'message', id, role, content, createdAt: 'now' }
}

const THREE_OF_SIX = snapshot([
  task('1', 'completed', 'Read the design'),
  task('2', 'completed', 'Sketch the model'),
  task('3', 'completed', 'Write the fold'),
  task('4', 'in_progress', 'Wire the panel', 'Wiring the panel'),
  task('5', 'pending', 'Style the strip'),
  task('6', 'pending', 'Regression pass'),
], '4')

test('no records, no tool_result and no snapshot each mean no panel at all', () => {
  assert.equal(taskPanelState([]), undefined)
  assert.equal(taskPanelState([message('u1', 'user', 'go')]), undefined)
  assert.equal(
    taskPanelState([{
      type: 'tool_result', id: 'r1', toolUseId: 'u1', tool: 'Read', ok: true, content: 'x', createdAt: 'now',
      display: { summary: 'Read a.ts' },
    }]),
    undefined,
    'a display without a snapshot is not a checklist',
  )
})

test('an empty checklist is not a panel either', () => {
  assert.equal(taskPanelState([todoWrite('r1', snapshot([]))]), undefined)
})

test('the newest snapshot wins outright — snapshots replace, they do not accumulate', () => {
  const state = taskPanelState([
    message('u1', 'user', 'go'),
    todoWrite('r1', snapshot([task('1', 'pending', 'Read the design')])),
    todoWrite('r2', THREE_OF_SIX),
  ])
  assert.ok(state)
  assert.equal(state.tasks.length, 6)
  assert.deepEqual(
    state.counts,
    { total: 6, remaining: 3, pending: 2, inProgress: 1, completed: 3 },
  )
})

test('progress ratio and the active task drive the collapsed strip', () => {
  const state = taskPanelState([todoWrite('r1', THREE_OF_SIX)])
  assert.ok(state)
  assert.equal(state.ratio, 0.5, '3/6 fills the 2px bar halfway')
  assert.equal(state.allDone, false)
  assert.equal(state.activeTask?.id, '4')
  assert.equal(state.activeTask?.label, 'Wiring the panel', 'a running task reads as its activeForm')
  assert.equal(state.tasks[4]?.label, 'Style the strip', 'everything else reads as its subject')
})

test('the active task falls back to the running row when activeTaskId is stale', () => {
  const stale = snapshot([
    task('1', 'completed', 'Done'),
    task('2', 'in_progress', 'Running', 'Running it'),
  ], '9')
  assert.equal(taskPanelState([todoWrite('r1', stale)])?.activeTask?.id, '2')
})

test('with nothing in progress there is no active task', () => {
  const state = taskPanelState([todoWrite('r1', snapshot([task('1', 'pending', 'Later')]))])
  assert.ok(state)
  assert.equal(state.activeTask, undefined)
  assert.equal(state.ratio, 0)
})

test('deleted tasks leave the panel and its counts, so the bar can reach full', () => {
  const withDeleted = snapshot([
    task('1', 'completed', 'Kept'),
    task('2', 'deleted', 'Dropped'),
  ])
  const state = taskPanelState([todoWrite('r1', withDeleted)])
  assert.ok(state)
  assert.deepEqual(state.tasks.map((t) => t.id), ['1'])
  assert.equal(state.counts.total, 1, 'the snapshot counted the deleted row; the panel does not')
  assert.equal(state.ratio, 1)
  assert.equal(state.allDone, true)
})

test('a finished checklist survives the rest of its turn', () => {
  const done = snapshot([task('1', 'completed', 'Kept'), task('2', 'completed', 'Also kept')])
  const state = taskPanelState([
    message('u1', 'user', 'go'),
    todoWrite('r1', done),
    message('a1', 'assistant', 'all done'),
  ])
  assert.ok(state, 'the answer that follows is not a reason to yank the list away')
  assert.equal(state.allDone, true)
  assert.equal(state.ratio, 1)
})

test('the next user message retires a finished checklist', () => {
  const done = snapshot([task('1', 'completed', 'Kept')])
  assert.equal(
    taskPanelState([todoWrite('r1', done), message('u2', 'user', 'next thing')]),
    undefined,
  )
})

test('a system-reminder user record is not the user starting something new', () => {
  const done = snapshot([task('1', 'completed', 'Kept')])
  const state = taskPanelState([
    todoWrite('r1', done),
    message('u2', 'user', wrapInSystemReminder('background nudge')),
  ])
  assert.ok(state, 'a model-facing nudge is invisible in the transcript and here too')
})

test('an unfinished checklist outlives the turn that made it', () => {
  const state = taskPanelState([
    todoWrite('r1', THREE_OF_SIX),
    message('u2', 'user', 'keep going'),
  ])
  assert.ok(state, 'the plan is still the plan')
  assert.equal(state.counts.remaining, 3)
})

test('transcript-reset clears the panel, because the record list it scans is gone', () => {
  assert.ok(taskPanelState([todoWrite('r1', THREE_OF_SIX)]))
  assert.equal(taskPanelState([]), undefined)
})

test('taskPanelStateFromSnapshot projects a live snapshot the same way', () => {
  assert.deepEqual(
    taskPanelStateFromSnapshot(THREE_OF_SIX),
    taskPanelState([todoWrite('r1', THREE_OF_SIX)]),
  )
  assert.equal(taskPanelStateFromSnapshot(undefined), undefined)
})

// --- the live path (T10) -----------------------------------------------------

/** What the pane does: fold the same records one at a time, in order. */
function live(records: readonly SessionRecord[]): TaskPanelState | undefined {
  return records.reduce<TaskPanelState | undefined>(
    (state, record) => advanceTaskPanel(state, record),
    undefined,
  )
}

test('folding records forward lands where the reverse scan does', () => {
  const done = snapshot([task('1', 'completed', 'Kept')])
  const histories: SessionRecord[][] = [
    [],
    [todoWrite('r1', THREE_OF_SIX)],
    [todoWrite('r1', THREE_OF_SIX), todoWrite('r2', done)],
    [todoWrite('r1', done), message('u2', 'user', 'next thing')],
    [todoWrite('r1', done), message('u2', 'user', wrapInSystemReminder('nudge'))],
    [todoWrite('r1', THREE_OF_SIX), message('u2', 'user', 'keep going')],
    [todoWrite('r1', done), message('u2', 'user', 'next'), todoWrite('r3', THREE_OF_SIX)],
  ]
  // The two paths meet on every pane switch — `hello` scans, everything after it
  // folds — so an answer either of them can reach alone is a bug.
  for (const records of histories) {
    assert.deepEqual(live(records), taskPanelState(records), JSON.stringify(records.map((r) => r.id)))
  }
})

test('a tool_result without a snapshot leaves the panel alone', () => {
  const state = live([
    todoWrite('r1', THREE_OF_SIX),
    { type: 'tool_result', id: 'r2', toolUseId: 'u2', tool: 'Read', ok: true, content: 'x', createdAt: 'now' },
  ])
  assert.equal(state?.counts.completed, 3)
})

test('retireCompletedTaskPanel drops a finished list and keeps an unfinished one', () => {
  const done = taskPanelStateFromSnapshot(snapshot([task('1', 'completed', 'Kept')]))
  assert.equal(retireCompletedTaskPanel(done), undefined)
  const running = taskPanelStateFromSnapshot(THREE_OF_SIX)
  assert.equal(retireCompletedTaskPanel(running), running)
  assert.equal(retireCompletedTaskPanel(undefined), undefined)
})
