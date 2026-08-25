import test from 'node:test'
import assert from 'node:assert/strict'

import {
  THINKING_DONE_FALLBACK,
  THINKING_LIVE_LABEL,
  isThinkingCollapsed,
  pruneThinkingToggles,
  thinkingHeaderLabel,
} from '../src/desktop/renderer/model/thinking.js'
import type { TranscriptItem } from '../src/desktop/renderer/model/transcript.js'

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
