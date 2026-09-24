import assert from 'node:assert/strict'
import test from 'node:test'

import { groupTranscript, type TranscriptItem } from '../src/desktop/renderer/model/transcript.js'
import {
  groupActivityLabel,
  turnActivity,
  waitingElapsedLabel,
  WAITING_CLOCK_AFTER_MS,
} from '../src/desktop/renderer/model/waiting.js'

/**
 * Where the live status is said (`src/desktop/renderer/model/waiting.ts`).
 *
 * Two decisions, both pure: *whether* the tail row is drawn and which group is
 * live, and *what the row reads* while the turn works. `test/rendererTranscriptView.test.ts` covers what each
 * one is made of in the DOM; this file covers when it exists at all.
 */

const TURN = 't1'
const STARTED_AT = 1_700_000_000_000
const USER: TranscriptItem = { id: 'u1', kind: 'user', text: '改一下侧栏', turnId: TURN }

function activity(items: readonly TranscriptItem[], isStreaming = true, turnId: string | undefined = TURN) {
  return turnActivity(groupTranscript(items), { isStreaming, startedAt: STARTED_AT, turnId })
}

function group(steps: readonly TranscriptItem[]) {
  return [USER, ...steps]
}

const THINKING: TranscriptItem = { id: 'thinking-0', kind: 'thinking', text: '先看看', pending: true, turnId: TURN }
const RUNNING_BASH: TranscriptItem = {
  id: 'call-1',
  kind: 'tool',
  text: 'Bash npm test',
  toolName: 'Bash',
  pending: true,
  turnId: TURN,
  tool: { displayName: 'Bash', useSummary: 'npm run test -- --reporter dot' },
}
const DONE_BASH: TranscriptItem = { ...RUNNING_BASH, pending: false, tool: { ...RUNNING_BASH.tool!, durationMs: 12 } }

test('an idle session says nothing at all', () => {
  const idle = activity([USER, DONE_BASH], false)
  assert.equal(idle.liveGroupId, undefined)
  assert.equal(idle.row, undefined)
})

test('the row is the tail for the whole turn, spoken only before the first step', () => {
  // No records yet, so no `turnId` and no group: the row is the only thing that
  // can say the turn is alive, and it appears once, so it is announced.
  const row = activity([USER], true, undefined)
  assert.deepEqual(row.row, { label: '正在思考', hint: 'Esc 中断', startedAt: STARTED_AT, announce: true })
  assert.equal(row.liveGroupId, undefined)

  // Once the turn opens a group the row stays at the tail — a long turn scrolls
  // its own top away — and it goes quiet: it now tracks the turn from step to
  // step, and each step's head announces what is new.
  const headed = activity(group([THINKING]))
  assert.deepEqual(headed.row, { label: '正在思考', hint: 'Esc 中断', startedAt: STARTED_AT, announce: false })
  assert.equal(headed.liveGroupId, TURN)
})

test('a draft that is actually arriving withdraws the row; an empty one does not', () => {
  const draft = (text: string): TranscriptItem => ({ id: '__draft__', kind: 'assistant', text, pending: true })
  assert.equal(activity([USER, draft('好的')], true, undefined).row, undefined)
  // `text_delta` can open the draft with an empty string, and an empty bubble is
  // exactly the blank page the row exists for.
  assert.ok(activity([USER, draft('')], true, undefined).row)
  assert.ok(activity([USER, draft('  \n')], true, undefined).row)
})

test('the group stays live between steps, where the group itself reads “done”', () => {
  // Every step has settled, so `ActivityGroup.status` is already 'done' — and
  // the turn is very much still running. The session's own `isStreaming` is the
  // only honest source for 「the turn is over」, or the head would flash 已处理
  // after every tool result.
  const between = activity(group([THINKING, DONE_BASH]))
  assert.equal(between.liveGroupId, TURN)
  assert.equal(between.row?.label, '正在思考')
  assert.equal(activity(group([THINKING, RUNNING_BASH])).row?.label, 'Bash')
})

test('a group from an earlier turn is never lit up by the next one', () => {
  const earlier: TranscriptItem = { ...DONE_BASH, id: 'call-0', turnId: 't0' }
  const next = turnActivity(groupTranscript([{ ...USER, turnId: 't0' }, earlier, { id: 'u2', kind: 'user', text: '再来' }]), {
    isStreaming: true,
    startedAt: STARTED_AT,
    turnId: undefined,
  })
  assert.equal(next.liveGroupId, undefined, 'the turn with no records yet owns no group')
  assert.ok(next.row, 'so the gap is the row’s again')
})

test('an interrupted turn is not live: its own head already says 已中断', () => {
  const interrupted: TranscriptItem = { id: 'stop', kind: 'notice', text: '已中断', turnId: TURN, interrupt: true }
  assert.equal(activity(group([DONE_BASH, interrupted])).liveGroupId, undefined)
})

test('the row reads the running tool’s name, and 正在思考 in between', () => {
  const groupOf = (items: readonly TranscriptItem[]) => {
    const entry = groupTranscript(items).find((one) => one.kind === 'group')
    assert.ok(entry?.kind === 'group')
    return entry.group
  }
  // The name only. The command it ran is one line below, on the step's own head,
  // where it can be opened — a head read to find out what is happening wants one
  // word, not a shell line.
  assert.equal(groupActivityLabel(groupOf(group([THINKING, RUNNING_BASH]))), 'Bash')
  assert.equal(groupActivityLabel(groupOf(group([THINKING, DONE_BASH]))), '正在思考')
  assert.equal(groupActivityLabel(groupOf(group([THINKING]))), '正在思考')
  // The last pending action wins: a batch settles in order, and the one still
  // open is the one being waited on.
  const second: TranscriptItem = { ...RUNNING_BASH, id: 'call-2', toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts' } }
  assert.equal(groupActivityLabel(groupOf(group([RUNNING_BASH, second]))), 'Read')
})

test('the clock is carried through, missing and all', () => {
  assert.equal(
    turnActivity(groupTranscript([USER]), { isStreaming: true, startedAt: undefined, turnId: undefined }).row?.startedAt,
    undefined,
  )
})

test('the counter stays empty until the wait is worth timing', () => {
  // The status appears the moment the turn starts; the number does not. Under
  // the threshold it would be read and gone before it meant anything.
  assert.equal(waitingElapsedLabel(0), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS - 1), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS), '5s')
  assert.equal(waitingElapsedLabel(63_000), '1m 3s')
})
