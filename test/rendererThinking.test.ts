import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_DISCLOSURE,
  THINKING_DONE_FALLBACK,
  THINKING_LIVE_LABEL,
  isGroupExpanded,
  isStepCollapsible,
  isStepExpanded,
  isThinkingCollapsed,
  pruneDisclosure,
  pruneThinkingToggles,
  thinkingHeaderLabel,
  toggleDisclosure,
} from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type {
  ActivityGroup,
  ActivityStep,
  ToolStepStatus,
  TranscriptEntry,
  TranscriptItem,
} from '../src/desktop/renderer/model/transcript.js'

/**
 * The thinking disclosure's decisions, which are all pure: what the header says,
 * whether the block is open, and which toggles are still about a block that exists.
 */

const live = (id = 'thinking-0'): TranscriptItem => ({ id, kind: 'thinking', text: 'why', pending: true })
const sealed = (summary?: string, id = 'thinking-0'): TranscriptItem => ({
  id, kind: 'thinking', text: 'why', ...(summary ? { summary } : {}),
})

test('the header says what the block is doing', () => {
  assert.equal(thinkingHeaderLabel(live()), THINKING_LIVE_LABEL)
  assert.equal(thinkingHeaderLabel(sealed('已处理 7m 38s')), '已处理 7m 38s')
  // An aborted turn seals the block without an elapsed time, and the header still
  // has to name what it opens.
  assert.equal(thinkingHeaderLabel(sealed()), THINKING_DONE_FALLBACK)
})

test('the default is open while streaming and closed once sealed', () => {
  const none: ReadonlySet<string> = new Set()
  assert.equal(isThinkingCollapsed(live(), none), false)
  assert.equal(isThinkingCollapsed(sealed('已处理 1s'), none), true)
})

test('a toggle inverts that default rather than storing a state', () => {
  // Which is what lets an expansion made mid-turn survive the moment `turn-end`
  // seals the block: an absolute value would be overwritten exactly then.
  const toggled: ReadonlySet<string> = new Set(['thinking-0'])
  assert.equal(isThinkingCollapsed(live(), toggled), true, 'closed by hand while streaming')
  assert.equal(isThinkingCollapsed(sealed('已处理 1s'), toggled), false, 'opened by hand, and it stays open')

  // Nothing about another block's id may leak across.
  assert.equal(isThinkingCollapsed(live('thinking-1'), toggled), false)
})

test('pruning drops toggles for blocks that are gone', () => {
  const items: TranscriptItem[] = [
    { id: 'm1', kind: 'user', text: 'hi' },
    sealed('已处理 1s', 'thinking-3'),
  ]

  assert.deepEqual(
    [...pruneThinkingToggles(items, new Set(['thinking-3', 'thinking-0', 'm1']))],
    ['thinking-3'],
    'a `transcript-reset` restarts the counter, so a stale id would be inherited by a different block',
  )
  assert.deepEqual([...pruneThinkingToggles([], new Set(['thinking-0']))], [])
})

/**
 * §5's disclosure: a dynamic default plus the user's absolute answer.
 */

const toolStep = (id: string, status: ToolStepStatus): ActivityStep => ({
  kind: 'tool',
  id,
  text: id,
  status,
  tool: { displayName: 'Read', useSummary: 'a.ts' },
  ...(status === 'running' || status === 'awaiting-approval' ? { pending: true as const } : {}),
  ...(status === 'failed' ? { failed: true as const } : {}),
})

const group = (steps: readonly ActivityStep[], status: ActivityGroup['status']): ActivityGroup => ({
  turnId: 'turn-1',
  steps,
  status,
  stepCount: steps.length,
  failedCount: steps.filter((step) => 'status' in step && step.status === 'failed').length,
})

test('the group is open while the turn runs and closed once it is over', () => {
  const steps = [toolStep('a', 'done')]
  assert.equal(isGroupExpanded(group(steps, 'running')), true)
  assert.equal(isGroupExpanded(group(steps, 'done')), false)
  assert.equal(isGroupExpanded(group(steps, 'aborted')), false)
})

test('only the current step of a running turn is open by default', () => {
  const running = group([toolStep('a', 'done'), toolStep('b', 'done'), toolStep('c', 'running')], 'running')
  assert.deepEqual(
    running.steps.map((_step, index) => isStepExpanded(running, index)),
    [false, false, true],
  )

  // Once the turn ends nothing is current, so everything collapses.
  const done = group([toolStep('a', 'done'), toolStep('b', 'done')], 'done')
  assert.deepEqual(done.steps.map((_step, index) => isStepExpanded(done, index)), [false, false])
})

test('a failed step opens itself, and one waiting for approval does not', () => {
  const sealed = group([toolStep('a', 'done'), toolStep('b', 'failed')], 'done')
  assert.deepEqual(sealed.steps.map((_step, index) => isStepExpanded(sealed, index)), [false, true])

  // The permission request is drawn in the composer; the transcript must not pull
  // the focus back up, not even though this is the running turn's last step.
  const asking = group([toolStep('a', 'done'), toolStep('b', 'awaiting-approval')], 'running')
  assert.deepEqual(asking.steps.map((_step, index) => isStepExpanded(asking, index)), [false, false])
})

test('a step with no body is never a disclosure', () => {
  const text: ActivityStep = { kind: 'text', id: 't', text: 'staged' }
  const task: ActivityStep = {
    kind: 'task', id: 'todo', text: 'TodoWrite', status: 'done',
    tool: { displayName: 'TodoWrite', useSummary: '' },
  }
  const system: ActivityStep = { kind: 'system', id: 's', text: 'Context compacted.' }
  for (const step of [text, task, system]) {
    assert.equal(isStepCollapsible(step), false, step.kind)
    const sealed = group([step], 'done')
    // Shown whole even under a collapsing default, and even if a stale answer
    // claims otherwise: there is nothing to fold.
    assert.equal(isStepExpanded(sealed, 0), true)
    assert.equal(isStepExpanded(sealed, 0, new Map([[step.id, false]])), true)
  }
  assert.equal(isStepExpanded(group([], 'done'), 0), false, 'no such step')
})

test('a hand-collapsed current step stays collapsed when the next step arrives', () => {
  // The case the deviation model got wrong: under it the arriving step flips the
  // default to「collapsed」and the recorded deviation re-opens what the user shut.
  const running = group([toolStep('a', 'running')], 'running')
  assert.equal(isStepExpanded(running, 0), true)

  const state = toggleDisclosure(NO_DISCLOSURE, 'a', isStepExpanded(running, 0))
  assert.equal(isStepExpanded(running, 0, state), false, 'closed by hand')

  const grown = group([toolStep('a', 'done'), toolStep('b', 'running')], 'running')
  assert.equal(isStepExpanded(grown, 0, state), false, 'and it stays closed')
  assert.equal(isStepExpanded(grown, 1, state), true)

  // Absolute, so the answer also survives the turn ending under it.
  assert.equal(isStepExpanded(group([toolStep('a', 'done')], 'done'), 0, state), false)
})

test('a hand-opened step survives the automatic collapse at turn end', () => {
  const sealed = group([toolStep('a', 'done'), toolStep('b', 'done')], 'done')
  const state = toggleDisclosure(NO_DISCLOSURE, 'a', isStepExpanded(sealed, 0))
  assert.equal(isStepExpanded(sealed, 0, state), true)
  assert.equal(isStepExpanded(sealed, 1, state), false, 'and nothing leaks to its neighbour')
})

test('a hand-answered group ignores its own default from then on', () => {
  const running = group([toolStep('a', 'running')], 'running')
  const state = toggleDisclosure(NO_DISCLOSURE, running.turnId, isGroupExpanded(running))
  assert.equal(isGroupExpanded(running, state), false)
  assert.equal(isGroupExpanded(group([toolStep('a', 'done')], 'done'), state), false)

  // And a second click is a second absolute value, not a stack of deviations.
  const reopened = toggleDisclosure(state, running.turnId, false)
  assert.equal(isGroupExpanded(running, reopened), true)
})

test('pruning keeps only groups, steps and loose thinking blocks that exist', () => {
  const live = group([toolStep('a', 'done')], 'done')
  const entries: TranscriptEntry[] = [
    { kind: 'item', item: { id: 'm1', kind: 'user', text: 'hi' } },
    { kind: 'group', group: live },
    { kind: 'item', item: { id: 'loose-thinking', kind: 'thinking', text: 'why' } },
  ]
  const state: DisclosureState = new Map([
    ['turn-1', false],
    ['a', true],
    ['loose-thinking', true],
    ['m1', true],
    ['turn-0', true],
    ['thinking-0', false],
  ])

  assert.deepEqual(
    [...pruneDisclosure(entries, state)],
    [['turn-1', false], ['a', true], ['loose-thinking', true]],
  )
  // A `transcript-reset` restarts the id counter, so nothing may survive it.
  assert.deepEqual([...pruneDisclosure([], state)], [])
})
