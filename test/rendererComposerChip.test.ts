import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LABELS,
  composerChipView,
  insertMentionToken,
  submitLabel,
} from '../src/desktop/renderer/model/composer.js'
import type { WireRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The composer chip's decisions, with no DOM in sight — the `model/` half of
 * the renderer's split, same as `test/rendererSidebar.test.ts`.
 */

function runtime(overrides: Partial<WireRuntimeSnapshot> = {}): WireRuntimeSnapshot {
  return {
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

test('the chip is inert until a runtime snapshot arrives', () => {
  // A pane that has not finished starting must not show the *previous* pane's
  // model, which is why `renderStatus` repaints the chip even with no snapshot.
  const view = composerChipView(undefined)
  assert.equal(view.enabled, false)
  assert.equal(view.model, '…')
  assert.equal(view.effort, '…')
  assert.equal(view.atCeiling, false)
})

test('the chip shows the model and the effort level', () => {
  const view = composerChipView(runtime())
  assert.equal(view.model, 'claude-sonnet-5')
  assert.equal(view.effort, EFFORT_LABELS.high)
  assert.equal(view.enabled, true)
  assert.match(view.modelTitle, /claude-sonnet-5/)
})

test('the provider is in the tooltip, not the chip', () => {
  // The chip has room for a name, not a name and a vendor; the vendor is the
  // kind of thing you go looking for rather than read at a glance.
  const view = composerChipView(runtime({ providerName: 'anthropic' }))
  assert.equal(view.model, 'claude-sonnet-5')
  assert.match(view.modelTitle, /anthropic/)
})

test('a raw token budget is shown verbatim', () => {
  // `WireRuntimeSnapshot.effort` is a string because `set-effort.level` accepts
  // a decimal token budget as well as a level name. A budget has no rung on the
  // ladder, so there is no label to map it to.
  const view = composerChipView(runtime({ effort: '32000' }))
  assert.equal(view.effort, '32000')
  assert.equal(view.atCeiling, false, 'a budget cannot be compared against a level ceiling')
})

test('atCeiling is true at the model maximum and false below it', () => {
  assert.equal(composerChipView(runtime({ effort: 'high', maxEffort: 'high' })).atCeiling, true)
  assert.equal(composerChipView(runtime({ effort: 'medium', maxEffort: 'high' })).atCeiling, false)
  // At or above, not merely equal: a stale config can leave effort past the
  // ceiling, and the chip should still say "this is as far as it goes".
  assert.equal(composerChipView(runtime({ effort: 'max', maxEffort: 'high' })).atCeiling, true)
  assert.equal(composerChipView(runtime({ effort: 'max' })).atCeiling, false, 'no ceiling declared')
})

test('the ceiling is explained in the tooltip when it has been reached', () => {
  const capped = composerChipView(runtime({ effort: 'high', maxEffort: 'high' }))
  assert.match(capped.effortTitle, /上限/)
  const room = composerChipView(runtime({ effort: 'low', maxEffort: 'high' }))
  assert.doesNotMatch(room.effortTitle, /上限/)
})

test('every effort level has a label', () => {
  // Guards the chip against rendering `undefined` if a level is ever added.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(typeof EFFORT_LABELS[level], 'string')
    assert.ok(EFFORT_LABELS[level].length > 0)
  }
})

test('the send button relabels rather than disabling mid-turn', () => {
  // The button stays enabled while streaming, and the Enter path reaches the
  // same verdict: `requestSubmit()` ignores a disabled button, so a disagreement
  // here swallows the click silently.
  assert.notEqual(submitLabel(true), submitLabel(false))
})

// --- the attachment control -------------------------------------------------

test('the mention token goes in at the caret, not at the end', () => {
  assert.deepEqual(insertMentionToken('hello world', 5), { text: 'hello @ world', cursorPos: 7 })
})

test('a mid-word caret gets a space first, so the mention starts a token', () => {
  // Without it the control produces `foo@`, which the mention scanner does not
  // recognise — the completion would simply never open.
  assert.deepEqual(insertMentionToken('foo', 3), { text: 'foo @', cursorPos: 5 })
})

test('no space is added where one is not needed', () => {
  assert.deepEqual(insertMentionToken('', 0), { text: '@', cursorPos: 1 })
  assert.deepEqual(insertMentionToken('foo ', 4), { text: 'foo @', cursorPos: 5 })
  assert.deepEqual(insertMentionToken('foo\n', 4), { text: 'foo\n@', cursorPos: 5 })
})

test('an @ already before the caret is left alone rather than doubled', () => {
  assert.deepEqual(insertMentionToken('see @', 5), { text: 'see @', cursorPos: 5 })
})

test('an out-of-range caret is clamped rather than producing a hole', () => {
  assert.deepEqual(insertMentionToken('ab', 99), { text: 'ab @', cursorPos: 4 })
  assert.deepEqual(insertMentionToken('ab', -3), { text: '@ab', cursorPos: 1 })
})
