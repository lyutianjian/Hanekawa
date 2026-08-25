import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionEvent,
  createTranscriptState,
  formatTurnSummary,
  formatWorkedDuration,
  toolCallSummary,
} from '../src/desktop/renderer/model/transcript.js'
import type { TranscriptState } from '../src/desktop/renderer/model/transcript.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { SessionRecord } from '../src/harness/types.js'

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

test('the tool summary picks the most identifying argument', () => {
  assert.equal(toolCallSummary('Bash', { command: 'ls -la' }), 'Bash(ls -la)')
  assert.equal(toolCallSummary('Read', { filePath: 'a.txt' }), 'Read(a.txt)')
  assert.equal(toolCallSummary('Grep', { pattern: 'foo' }), 'Grep(foo)')
  assert.equal(toolCallSummary('Weird', { unknown: 1 }), 'Weird')
})
