import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserOwnership, TAKEOVER_MESSAGE } from '../src/desktop/browser/ownership.js'

/**
 * Arbitration is a state machine over five maps, so these tests are the machine
 * and nothing else: no window, no tab, no page. What they pin down is the part
 * that is easy to get subtly wrong — when a block lifts, what a takeover reaches,
 * and which in-flight operations a new turn retires.
 */

function codeOf(fn: () => void): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

test('a takeover blocks the session that drove the tab, until its next turn', () => {
  const own = new BrowserOwnership()
  const first = own.observeTurn('s1', 'turn-1')
  own.claim('tab-1', 's1')
  own.assertAllowed('s1', first.revision)

  assert.equal(own.takeOver('tab-1'), true)
  assert.equal(codeOf(() => own.assertAllowed('s1', first.revision)), 'BROWSER_USER_TAKEOVER')
  try {
    own.assertAllowed('s1', first.revision)
  } catch (error) {
    assert.equal((error as Error).message, TAKEOVER_MESSAGE)
  }

  // Same turn, still blocked: the retry a model makes inside the turn it was
  // told to stop in must not be what releases it.
  const again = own.observeTurn('s1', 'turn-1')
  assert.equal(codeOf(() => own.assertAllowed('s1', again.revision)), 'BROWSER_USER_TAKEOVER')

  const next = own.observeTurn('s1', 'turn-2')
  assert.deepEqual(next.released, ['tab-1'])
  own.assertAllowed('s1', next.revision)
  assert.equal(own.isBlocked('s1'), false)
})

test('a new turn retires the operations still running from the last one', () => {
  const own = new BrowserOwnership()
  const inFlight = own.observeTurn('s1', 'turn-1').revision
  const current = own.observeTurn('s1', 'turn-2').revision

  own.assertAllowed('s1', current)
  assert.equal(codeOf(() => own.assertAllowed('s1', inFlight)), 'OPERATION_ABORTED')
})

test('a takeover reaches only the session that was driving', () => {
  const own = new BrowserOwnership()
  const a = own.observeTurn('s1', 't1').revision
  const b = own.observeTurn('s2', 't1').revision
  own.claim('tab-1', 's1')
  own.claim('tab-2', 's2')

  own.takeOver('tab-1')
  assert.equal(codeOf(() => own.assertAllowed('s1', a)), 'BROWSER_USER_TAKEOVER')
  own.assertAllowed('s2', b)

  // A tab nobody has driven has nobody to take it from.
  assert.equal(own.takeOver('tab-3'), false)
})

test('the agent closing its own tab is not the user taking it', () => {
  const own = new BrowserOwnership()
  const revision = own.observeTurn('s1', 't1').revision
  own.claim('tab-1', 's1')

  const outer = own.expectAgentClose('tab-1')
  const inner = own.expectAgentClose('tab-1')
  assert.equal(own.takeOver('tab-1'), false)
  inner()
  // Still bracketed: the reference count is what keeps the first close finishing
  // from uncovering the second.
  assert.equal(own.takeOver('tab-1'), false)
  inner()
  outer()
  assert.equal(own.takeOver('tab-1'), true)
  assert.equal(codeOf(() => own.assertAllowed('s1', revision)), 'BROWSER_USER_TAKEOVER')
})

test('a caller with no turn changes nothing, and dropping a tab keeps the block', () => {
  const own = new BrowserOwnership()
  const first = own.observeTurn('s1').revision
  // A call outside a turn must not retire the operations a real turn has in
  // flight beside it, so it neither bumps the revision nor lifts a block.
  assert.equal(own.observeTurn('s1').revision, first)

  own.claim('tab-1', 's1')
  assert.equal(own.takeOver('tab-1'), true)
  own.dropTab('tab-1')
  assert.equal(own.isBlocked('s1'), true)
  assert.deepEqual(own.tabsOf('s1'), [])
})
