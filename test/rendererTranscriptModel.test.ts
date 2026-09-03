import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionEvent,
  createTranscriptState,
  formatTurnSummary,
  formatWorkedDuration,
  groupTranscript,
  toolCallSummary,
} from '../src/desktop/renderer/model/transcript.js'
import type {
  ActivityGroup,
  TranscriptItem,
  TranscriptState,
} from '../src/desktop/renderer/model/transcript.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { SessionRecord } from '../src/harness/types.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'

/**
 * The desktop transcript's fold over the controller's event stream.
 *
 * The renderer that shipped in 阶段 2b-2 handled two of the ten variants, so the
 * property that matters most here is coverage: every variant does something, and
 * the streaming draft is *replaced* by the record that follows it rather than
 * appended alongside it.
 */

function fold(events: SessionEvent[], initial?: TranscriptState) {
  let state = initial ?? createTranscriptState()
  const restored: string[] = []
  const models: string[] = []
  for (const event of events) {
    const outcome = applySessionEvent(state, event)
    state = outcome.state
    if (outcome.restoreInput !== undefined) restored.push(outcome.restoreInput)
    if (outcome.activeModel !== undefined) models.push(outcome.activeModel)
  }
  return { state, restored, models }
}

function message(id: string, role: 'user' | 'assistant', content: string): SessionRecord {
  return { type: 'message', id, role, content, createdAt: 'now' }
}

const ALL_EVENT_TYPES: SessionEvent['type'][] = [
  'turn-start',
  'record',
  'stream',
  'tool-progress',
  'notice',
  'transcript-reset',
  'restore-input',
  'active-model',
  'turn-end',
]

test('every SessionEvent variant is handled, none throws', () => {
  const samples: SessionEvent[] = [
    { type: 'turn-start', messageId: 'm1', displayInput: 'hello', createdAt: 'now' },
    { type: 'record', record: message('m1', 'user', 'hello') },
    { type: 'stream', event: { type: 'text_delta', text: 'hi' } },
    { type: 'tool-progress', listContent: 'Reading a.txt' },
    { type: 'notice', level: 'system', content: 'note' },
    { type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: false },
    { type: 'restore-input', text: 'unsent' },
    { type: 'active-model', model: { model: 'claude-fallback', modelKey: 'fallback' } as never },
    { type: 'turn-end', aborted: false, rolledBack: false, durationMs: 1200 },
  ]

  assert.deepEqual(samples.map((event) => event.type).sort(), [...ALL_EVENT_TYPES].sort())
  assert.doesNotThrow(() => fold(samples))
})

test('an unknown event type throws rather than being silently dropped', () => {
  // `assertNever` is what makes the exhaustive switch load-bearing; without it a
  // new variant compiles clean and vanishes at runtime.
  assert.throws(
    () => applySessionEvent(createTranscriptState(), { type: 'invented' } as never),
    /Unhandled session event/,
  )
})

test('a streamed draft is replaced by the assistant record, not appended twice', () => {
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    { type: 'stream', event: { type: 'text_delta', text: 'Hel' } },
    { type: 'stream', event: { type: 'text_delta', text: 'lo!' } },
    { type: 'record', record: message('a1', 'assistant', 'Hello!') },
  ])

  const assistant = state.items.filter((item) => item.kind === 'assistant')
  assert.equal(assistant.length, 1, 'two bubbles is the duplicate the terminal avoids')
  assert.equal(assistant[0]?.text, 'Hello!')
  assert.equal(assistant[0]?.pending, undefined, 'the committed record is not pending')
})

/**
 * The user's own message is drawn twice unless `applyRecord` is idempotent by
 * id: `turn-start` puts it on screen immediately under `event.messageId`, and
 * `SessionController.submit` hands that very id to `AgentLoop`, which stamps it
 * on the persisted `message` record. The TUI dodges this by ignoring user
 * records entirely (`useAgentLoop.ts` only folds `role === 'assistant'`); here
 * the record is the authoritative text, so it replaces in place.
 */
test('the user message record replaces its turn-start bubble instead of doubling it', () => {
  const record: SessionRecord = {
    type: 'message', id: 'm1', role: 'user', content: '<long prompt>',
    displayContent: '/skill arg', createdAt: 'now',
  }

  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    { type: 'record', record },
  ])

  const user = state.items.filter((item) => item.kind === 'user')
  assert.equal(user.length, 1, 'two identical bubbles is the desktop smoke-test duplicate')
  assert.equal(user[0]?.text, '/skill arg', 'the record carries displayContent; turn-start does not')
})

test('a user record for a different turn still appends', () => {
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'first', createdAt: 'now' },
    { type: 'record', record: message('m1', 'user', 'first') },
    { type: 'record', record: message('m2', 'user', 'second') },
  ])

  assert.deepEqual(
    state.items.filter((item) => item.kind === 'user').map((item) => item.text),
    ['first', 'second'],
  )
})

test('a draft that never became a record is dropped at turn-end', () => {  const { state } = fold([
    { type: 'stream', event: { type: 'text_delta', text: 'partial' } },
    { type: 'turn-end', aborted: true, rolledBack: false, durationMs: 900 },
  ])

  assert.deepEqual(state.items, [], 'a pending bubble would sit there looking live forever')
})

// --- thinking blocks (5d) ---------------------------------------------------
//
// The contract changed in 5d: a thinking block used to be a 240-character tail
// peek that `turn-end` deleted. It is now the turn's collapsible header, so it is
// retained in full, sealed rather than dropped, and it carries the elapsed time
// that used to be a separate `duration` line.

const thinkingDelta = (thinking: string): SessionEvent => ({
  type: 'stream',
  event: { type: 'thinking_delta', thinking },
})

const turnEnd = (durationMs: number, aborted = false): SessionEvent => ({
  type: 'turn-end', aborted, rolledBack: false, durationMs,
})

const thinkingItems = (state: TranscriptState) => state.items.filter((item) => item.kind === 'thinking')

test('a turn keeps one thinking block, and its text is retained in full', () => {
  const long = 'x'.repeat(500)
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    thinkingDelta(long),
    thinkingDelta('!'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text.length, item.pending]), [
    ['thinking-0', 501, true],
  ])
  assert.equal(state.isThinking, true)
  assert.equal(state.thinkingCount, 1)
})

test('a second block after a tool round trip joins the turn is first one', () => {
  // `message_start` and the assistant record are both mid-turn boundaries that used
  // to delete the block. They must not, or the header loses the reasoning it
  // promises to expand.
  const { state } = fold([
    thinkingDelta('before'),
    { type: 'record', record: message('a1', 'assistant', 'calling a tool') },
    { type: 'stream', event: { type: 'message_start' } },
    thinkingDelta(' after'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => item.text), ['before after'])
})

test('thinking_stop does not close the block, so the live face survives it', () => {
  // This is what pins「活标签由 item.pending 驱动，不由 state.isThinking 驱动」:
  // the flag goes false here while the very same block keeps arriving.
  const { state } = fold([
    thinkingDelta('a'),
    { type: 'stream', event: { type: 'thinking_stop' } },
    thinkingDelta('b'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.pending]), [
    ['thinking-0', 'ab', true],
  ])
})

test('turn-end seals the block and hands it the turn is elapsed time', () => {
  const { state } = fold([thinkingDelta('why'), turnEnd(458_000)])

  assert.deepEqual(thinkingItems(state).map((item) => [item.pending, item.summary]), [
    [undefined, '已处理 7m 38s'],
  ])
  assert.equal(state.isThinking, false)
})

test('a turn that thought has no separate duration line; one that did not still does', () => {
  const { state: thought } = fold([thinkingDelta('why'), turnEnd(1200)])
  assert.equal(thought.items.some((item) => item.kind === 'duration'), false, 'the header already says it')

  const { state: quiet } = fold([
    { type: 'stream', event: { type: 'text_delta', text: 'hi' } },
    { type: 'record', record: message('a1', 'assistant', 'hi') },
    turnEnd(1200),
  ])
  assert.deepEqual(
    quiet.items.filter((item) => item.kind === 'duration').map((item) => item.text),
    ['已处理 1s'],
  )
})

test('an aborted turn seals the block without a summary', () => {
  const { state } = fold([thinkingDelta('why'), turnEnd(900, true)])

  assert.deepEqual(thinkingItems(state).map((item) => [item.pending, item.summary]), [[undefined, undefined]])
  assert.equal(state.items.some((item) => item.kind === 'duration'), false)
})

test('a later turn-end leaves an earlier turn is block alone', () => {
  const { state } = fold([
    thinkingDelta('first'),
    turnEnd(458_000),
    thinkingDelta('second'),
    turnEnd(2000),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.summary]), [
    ['thinking-0', 'first', '已处理 7m 38s'],
    ['thinking-1', 'second', '已处理 2s'],
  ])
})

test('block ids come from a counter, not from the list length', () => {
  // `turn-end` drops the draft, so the list shrinks between turns: two blocks would
  // be minted at the same length and a single toggle would fold both.
  const { state } = fold([
    thinkingDelta('first'),
    { type: 'stream', event: { type: 'text_delta', text: 'partial' } },
    turnEnd(1000, true),
    thinkingDelta('second'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => item.id), ['thinking-0', 'thinking-1'])
})

test('transcript-reset drops a block that was still arriving', () => {
  const { state: mid } = fold([thinkingDelta('half a thought')])
  const { state } = fold(
    [{ type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: false }],
    mid,
  )

  assert.deepEqual(thinkingItems(state), [])
  assert.equal(state.thinkingCount, 0, 'and the counter restarts — which is why the view prunes its toggles')
})

test('the elapsed time reads as minutes and seconds, with a tenth under a second', () => {
  assert.equal(formatWorkedDuration(458_000), '7m 38s')
  assert.equal(formatWorkedDuration(62_000), '1m 2s')
  assert.equal(formatWorkedDuration(3400), '3s', 'above a second the fraction is noise')
  assert.equal(formatWorkedDuration(1000), '1s')
  // `已处理 0s` reads as a broken clock, so a sub-second turn keeps its fraction.
  assert.equal(formatWorkedDuration(420), '0.4s')
  assert.equal(formatWorkedDuration(-5), '0s')
})

test('a tool result replaces the pending call row it answers', () => {
  const toolUse: SessionRecord = {
    type: 'tool_use', id: 'tu1', tool: 'Read', input: { filePath: 'a.txt' },
    riskLevel: 'safe', createdAt: 'now',
  }
  const toolResult: SessionRecord = {
    type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Read', ok: true,
    content: 'file body\nmore', createdAt: 'now',
  }

  const { state: pending } = fold([{ type: 'record', record: toolUse }])
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0]?.pending, true)
  assert.equal(pending.items[0]?.text, 'Read(a.txt)')

  const { state } = fold([{ type: 'record', record: toolResult }], pending)
  assert.equal(state.items.length, 1, 'the call and its result are one row')
  assert.equal(state.items[0]?.pending, undefined)
  // `tool`, not `toolName` — the field the shipped renderer read wrongly.
  assert.equal(state.items[0]?.toolName, 'Read')
  assert.match(state.items[0]?.text ?? '', /^Read → file body/)
})

test('a failed tool result is marked failed', () => {
  const { state } = fold([{
    type: 'record',
    record: {
      type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Bash', ok: false,
      content: 'command not found', createdAt: 'now',
    },
  }])

  assert.equal(state.items[0]?.failed, true)
  assert.match(state.items[0]?.text ?? '', /Bash failed: command not found/)
})

test('notices map to system and error rows', () => {
  const { state } = fold([
    { type: 'notice', level: 'system', content: 'connected' },
    { type: 'notice', level: 'error', content: 'boom' },
  ])

  assert.deepEqual(state.items.map((item) => [item.kind, item.text]), [
    ['notice', 'connected'],
    ['error', 'boom'],
  ])
})

test('transcript-reset rebuilds from records and only bumps the generation when asked', () => {
  const seeded = createTranscriptState([message('m1', 'user', 'old')])

  const { state: rollback } = fold([{
    type: 'transcript-reset', records: [message('m2', 'user', 'new')],
    systemMessages: ['restored'], bumpGeneration: false,
  }], seeded)
  assert.deepEqual(rollback.items.map((item) => item.text), ['new', 'restored'])
  assert.equal(rollback.generation, 0, 'a rollback must not remount the view')

  const { state: switched } = fold([{
    type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: true,
  }], rollback)
  assert.equal(switched.generation, 1)
})

test('restore-input and active-model leave the transcript alone and surface outward', () => {
  const seeded = createTranscriptState([message('m1', 'user', 'kept')])
  const { state, restored, models } = fold([
    { type: 'restore-input', text: 'unsent text' },
    { type: 'active-model', model: { model: 'claude-fallback' } as never },
  ], seeded)

  assert.deepEqual(restored, ['unsent text'], 'dropping this destroys the user\'s message')
  assert.deepEqual(models, ['claude-fallback'])
  assert.deepEqual(state.items.map((item) => item.text), ['kept'])
})

test('tool progress is state, not an item', () => {
  const { state } = fold([{ type: 'tool-progress', listContent: 'Reading a.txt' }])
  assert.equal(state.toolProgress, 'Reading a.txt')
  assert.deepEqual(state.items, [])
})

test('a failed turn still gets its duration line; an aborted one does not', () => {
  assert.equal(formatTurnSummary({ type: 'turn-end', aborted: false, rolledBack: false, durationMs: 1250 }), '已处理 1s')
  assert.equal(formatTurnSummary({ type: 'turn-end', aborted: true, rolledBack: false, durationMs: 1250 }), undefined)
})

test('bookkeeping records render nothing, and the visible ones read plainly', () => {
  const { state } = fold([
    { type: 'record', record: { type: 'tool_approval', id: 'ta1', toolUseId: 'tu1', tool: 'Read', approved: true, createdAt: 'now' } as never },
    { type: 'record', record: { type: 'message_queue', id: 'mq1', messages: [], createdAt: 'now' } as never },
    { type: 'record', record: { type: 'turn_interruption', id: 'ti1', userMessageId: 'm1', prompt: 'p', remainingTasks: [], recoverable: true, createdAt: 'now' } },
    { type: 'record', record: { type: 'compact_boundary', id: 'cb1', summary: 's', preTokens: 10, createdAt: 'now' } },
  ])

  assert.deepEqual(state.items.map((item) => item.text), ['Interrupted.', 'Context compacted.'])
})

test('a system-reminder user record is hidden from the transcript', () => {
  // The harness appends these as model-facing nudges (e.g. "all tool calls in
  // the previous turn failed"); the wrapper tag must not render as a user bubble.
  const record: SessionRecord = {
    type: 'message', id: 'r1', role: 'user',
    content: wrapInSystemReminder('All tool calls in the previous turn failed.'),
    createdAt: 'now',
  }

  const { state } = fold([{ type: 'record', record }])

  assert.equal(state.items.some((item) => item.kind === 'user'), false)
  assert.equal(state.items.length, 0, 'the nudge yields no item at all')
})

test('a user message that merely mentions the tag inline is still shown', () => {
  // Only an entire `<system-reminder>` block is hidden; an inline mention is real text.
  const { state } = fold([{
    type: 'record',
    record: message('m1', 'user', 'see <system-reminder> in the docs'),
  }])

  const user = state.items.filter((item) => item.kind === 'user')
  assert.equal(user.length, 1)
  assert.equal(user[0]?.text, 'see <system-reminder> in the docs')
})

test('the tool summary picks the most identifying argument', () => {
  assert.equal(toolCallSummary('Bash', { command: 'ls -la' }), 'Bash(ls -la)')
  assert.equal(toolCallSummary('Read', { filePath: 'a.txt' }), 'Read(a.txt)')
  assert.equal(toolCallSummary('Grep', { pattern: 'foo' }), 'Grep(foo)')
  assert.equal(toolCallSummary('Weird', { unknown: 1 }), 'Weird')
})

/**
 * 活动组（`activity_group_design.md` §4）: the replay path only — the live fold
 * keeps its shape until T3 moves `message_start` onto the same segmentation.
 * `groupTranscript` is a pure projection over `items`, so these read records in
 * and the group tree out.
 */

function stamped(record: SessionRecord, turnId: string, createdAt: string): SessionRecord {
  return { ...record, turnId, createdAt } as SessionRecord
}

function assistant(
  id: string,
  turnId: string,
  createdAt: string,
  content: string,
  thinking?: string[],
): SessionRecord {
  return {
    type: 'message', id, role: 'assistant', content, createdAt, turnId,
    ...(thinking ? { thinkingBlocks: thinking.map((text) => ({ type: 'thinking' as const, thinking: text })) } : {}),
  }
}

function toolUse(id: string, turnId: string, createdAt: string): SessionRecord {
  return { type: 'tool_use', id, tool: 'Read', input: { filePath: 'a.txt' }, riskLevel: 'safe', createdAt, turnId }
}

function toolResult(toolUseId: string, turnId: string, createdAt: string, ok = true): SessionRecord {
  return {
    type: 'tool_result', id: `${toolUseId}-r`, toolUseId, tool: 'Read', ok,
    content: ok ? 'contents' : 'boom', createdAt, turnId,
  }
}

function groupAt(entries: ReturnType<typeof groupTranscript>, index: number): ActivityGroup {
  const entry = entries[index]
  assert.equal(entry?.kind, 'group')
  return (entry as { kind: 'group'; group: ActivityGroup }).group
}

function itemAt(entries: ReturnType<typeof groupTranscript>, index: number): TranscriptItem {
  const entry = entries[index]
  assert.equal(entry?.kind, 'item')
  return (entry as { kind: 'item'; item: TranscriptItem }).item
}

function groupsOf(records: SessionRecord[]) {
  return groupTranscript(createTranscriptState(records).items)
}

test('a turn becomes one activity group: thinking and tools are steps, the answer stays outside', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    assistant('a1', 't1', '2026-01-01T00:00:01.000Z', '', ['思考A']),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.500Z'),
    toolResult('tu1', 't1', '2026-01-01T00:00:02.000Z'),
    assistant('a2', 't1', '2026-01-01T00:00:04.000Z', 'done', ['思考B']),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'group', 'item'])
  assert.equal(itemAt(entries, 0).kind, 'user')
  assert.equal(itemAt(entries, 2).text, 'done', 'the final answer is 正文, outside the group')

  const group = groupAt(entries, 1)
  assert.equal(group.turnId, 't1')
  assert.deepEqual(group.steps.map((step) => step.kind), ['thinking', 'tool', 'thinking'])
  assert.equal(group.stepCount, 3)
  assert.equal(group.failedCount, 0)
  assert.equal(group.status, 'done')
  assert.equal(group.durationMs, 4000, 'no turn-end to quote on replay: the records span the turn')
})

test('a failed call is counted, and a never-answered one keeps the group running', () => {
  const failed = groupAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now', false),
  ]), 1)
  assert.equal(failed.failedCount, 1)
  assert.equal(failed.status, 'done')

  const running = groupAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
  ]), 1)
  assert.equal(running.status, 'running')
})

test('an interrupted turn reads as aborted, and a compaction stays inside as a system step', () => {
  const group = groupAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    stamped({ type: 'compact_boundary', id: 'cb1', summary: 's', preTokens: 10, createdAt: 'now' }, 't1', 'now'),
    stamped(
      { type: 'turn_interruption', id: 'ti1', userMessageId: 'u1', prompt: 'p', remainingTasks: [], recoverable: true, createdAt: 'now' },
      't1',
      'now',
    ),
  ]), 1)

  assert.equal(group.status, 'aborted')
  assert.deepEqual(group.steps.map((step) => step.kind), ['tool', 'system', 'system'])
})

test('staged prose between tools is a step; only the last assistant text leaves the group', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', '先看文件'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a2', 't1', 'now', '看完了'),
  ])

  assert.deepEqual(
    groupAt(entries, 1).steps.map((step) => [step.kind, step.text]),
    [['text', '先看文件'], ['tool', 'Read → contents']],
  )
  assert.equal(itemAt(entries, 2).text, '看完了')
})

test('adjacent thinking with no tool between it is one segment', () => {
  const steps = groupAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', '', ['第一段', '第二段']),
    assistant('a2', 't1', 'now', '', ['第三段']),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a3', 't1', 'now', 'done', ['第四段']),
  ]), 1).steps

  assert.deepEqual(steps.map((step) => step.kind), ['thinking', 'tool', 'thinking'])
  assert.equal(steps[0]?.text, '第一段\n\n第二段\n\n第三段')
  assert.equal(steps[2]?.text, '第四段')
})

test('an old session without thinkingBlocks degrades to tool-only steps, unannotated', () => {
  const group = groupAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', ''),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a2', 't1', 'now', 'done'),
  ]), 1)

  assert.deepEqual(group.steps.map((step) => step.kind), ['tool'])
  assert.equal(group.steps.some((step) => step.text.includes('思考')), false)
})

test('a zero-step turn draws no empty group', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'hi'), 't1', 'now'),
    assistant('a1', 't1', 'now', 'hello'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item'])
})

test('turn-less items stay outside every group, in place', () => {
  const entries = groupsOf([
    message('u0', 'user', 'before'),
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'group'])
  assert.equal(itemAt(entries, 0).text, 'before')
})

test('two turns are two groups, in order', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'one'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a1', 't1', 'now', 'first'),
    stamped(message('u2', 'user', 'two'), 't2', 'now'),
    toolUse('tu2', 't2', 'now'),
    toolResult('tu2', 't2', 'now'),
    assistant('a2', 't2', 'now', 'second'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'group', 'item', 'item', 'group', 'item'])
  assert.equal(groupAt(entries, 1).turnId, 't1')
  assert.equal(groupAt(entries, 4).turnId, 't2')
})
