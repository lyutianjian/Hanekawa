import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRestoreOptions,
  formatDiffSummary,
  formatRestoreMessagePreview,
  getCheckpointRenderKey,
  isSummarizeDecision,
  rewindPartialFailureMessage,
  rewindStepsFor,
  rewindSuccessMessage,
  sortCheckpointsChronological,
  sortCheckpointsReverseChronological,
  truncateMessage,
  type RestoreDecision,
} from '../src/runtime/rewindPresentation.js'
import * as restoreMode from '../src/tui/components/RestoreMode.js'

/**
 * What `/rewind` offers and what each choice does, shared by both shells.
 *
 * The step order is the load-bearing part. `restore-code-and-conversation`
 * truncates the JSONL *before* it reverts the working tree, which is the only
 * reason `rewindPartialFailureMessage` exists — reverse the two and that message
 * describes a state that can no longer happen, while the state that does happen
 * (files reverted, conversation intact) has no message at all.
 */

const ALL_DECISIONS: readonly RestoreDecision[] = [
  'restore-code-and-conversation',
  'restore-conversation',
  'restore-code',
  'summarize-from-here',
  'summarize-up-to-here',
  'nevermind',
]

test('every decision has a step plan, and the destructive one truncates first', () => {
  assert.deepEqual(rewindStepsFor('restore-code-and-conversation'), ['truncate', 'restore-code'])
  assert.deepEqual(rewindStepsFor('restore-conversation'), ['truncate'])
  assert.deepEqual(rewindStepsFor('restore-code'), ['restore-code'])
  assert.deepEqual(rewindStepsFor('summarize-from-here'), ['summarize'])
  assert.deepEqual(rewindStepsFor('summarize-up-to-here'), ['summarize'])
  // The back affordance in option form: it performs nothing at all.
  assert.deepEqual(rewindStepsFor('nevermind'), [])
})

test('no decision is left without a plan', () => {
  for (const decision of ALL_DECISIONS) {
    const steps = rewindStepsFor(decision)
    assert.ok(Array.isArray(steps), `${decision} has no step plan`)
    for (const step of steps) {
      assert.ok(
        step === 'truncate' || step === 'restore-code' || step === 'summarize',
        `${decision} names an unknown step ${step}`,
      )
    }
  }
})

test('a step plan only summarizes for the decisions that carry a summary direction', () => {
  // `summarizeRewind` takes a `RewindSummaryDecision`, so a plan containing
  // `summarize` for anything else would be unrunnable.
  for (const decision of ALL_DECISIONS) {
    if (!rewindStepsFor(decision).includes('summarize')) continue
    assert.ok(isSummarizeDecision(decision), `${decision} cannot supply a summary direction`)
  }
})

test('every acting decision reports itself, and never mind says nothing', () => {
  assert.equal(
    rewindSuccessMessage('restore-conversation', 'add the parser'),
    'Conversation rewound to before "add the parser"',
  )
  assert.equal(
    rewindSuccessMessage('restore-code', 'add the parser'),
    'Code restored to before "add the parser"',
  )
  assert.equal(
    rewindSuccessMessage('restore-code-and-conversation', 'add the parser'),
    'Code and conversation rewound to before "add the parser"',
  )
  assert.equal(
    rewindSuccessMessage('summarize-from-here', 'add the parser'),
    'Summarized from "add the parser"',
  )
  assert.equal(
    rewindSuccessMessage('summarize-up-to-here', 'add the parser'),
    'Summarized up to before "add the parser"',
  )
  assert.equal(rewindSuccessMessage('nevermind', 'add the parser'), '')

  // Distinct wording per decision, or a user cannot tell what happened.
  const spoken = ALL_DECISIONS
    .filter((decision) => decision !== 'nevermind')
    .map((decision) => rewindSuccessMessage(decision, 'x'))
  assert.equal(new Set(spoken).size, spoken.length, 'two decisions report identically')
})

test('the half-done outcome says which half landed', () => {
  const message = rewindPartialFailureMessage('add the parser', 'git checkout failed')
  assert.match(message, /Conversation rewound to before "add the parser"/)
  assert.match(message, /file state could not be reverted: git checkout failed/)
  // Not reported as a failure: the truncation is real and already on disk.
  assert.doesNotMatch(message, /^Failed/)
})

test('the message preview is normalized and bounded', () => {
  assert.equal(formatRestoreMessagePreview('  add\n\tthe   parser  '), 'add the parser')
  const long = 'x'.repeat(80)
  const preview = formatRestoreMessagePreview(long)
  assert.equal(preview.length, 50)
  assert.ok(preview.endsWith('...'))
  // Exactly at the limit it is left alone.
  assert.equal(formatRestoreMessagePreview('y'.repeat(50)).length, 50)
  assert.doesNotMatch(formatRestoreMessagePreview('y'.repeat(50)), /\.\.\./)
})

/**
 * The re-export has to be the *same function*, not a copy.
 *
 * A second implementation behind the old name is exactly the failure this project
 * has hit before (`bridgeChannel.ts` shipped one channel while the suite tested
 * another). Identity is the cheapest way to make a fork fail here rather than in
 * a real rewind.
 */
test('RestoreMode re-exports the shared module rather than keeping a copy', () => {
  assert.equal(restoreMode.buildRestoreOptions, buildRestoreOptions)
  assert.equal(restoreMode.sortCheckpointsChronological, sortCheckpointsChronological)
  assert.equal(restoreMode.sortCheckpointsReverseChronological, sortCheckpointsReverseChronological)
  assert.equal(restoreMode.getCheckpointRenderKey, getCheckpointRenderKey)
  assert.equal(restoreMode.formatDiffSummary, formatDiffSummary)
  assert.equal(restoreMode.truncateMessage, truncateMessage)
})
