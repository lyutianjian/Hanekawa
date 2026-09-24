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

test('handing a tab back lifts the block now, without waiting for a turn', () => {
  const own = new BrowserOwnership()
  const revision = own.observeTurn('s1', 'turn-1').revision
  own.claim('tab-1', 's1')
  own.claim('tab-2', 's1')
  own.takeOver('tab-1')

  // Every tab the owner holds, not just the one pressed: the block is per
  // session, so a badge left on `tab-2` would outlive the state behind it.
  assert.deepEqual(own.release('tab-1').sort(), ['tab-1', 'tab-2'])
  assert.equal(own.isBlocked('s1'), false)
  // Still the same turn — a hand-back is not a new turn and retires nothing.
  own.assertAllowed('s1', revision)

  // Idempotent, so 「交还」 followed by a message does not redraw twice.
  assert.deepEqual(own.release('tab-1'), [])
  // And a tab nobody drove has nobody to hand it back to.
  assert.deepEqual(own.release('tab-9'), [])
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
  const first = own.observeTurn('s1', 't1').revision
  // A call outside a turn must not retire the operations a real turn has in
  // flight beside it, so it neither bumps the revision nor lifts a block.
  assert.equal(own.observeTurn('s1').revision, first)

  own.claim('tab-1', 's1')
  assert.equal(own.takeOver('tab-1'), true)
  assert.equal(own.observeTurn('s1').revision, first)
  assert.equal(own.isBlocked('s1'), true)
  own.dropTab('tab-1')
  assert.equal(own.isBlocked('s1'), true)
  assert.deepEqual(own.tabsOf('s1'), [])
})

test('a session is idle until a turn drives the browser, and idle again when it ends', () => {
  const own = new BrowserOwnership()
  assert.equal(own.driver('s1'), 'idle')
  // A turnless probe is not a turn.
  own.observeTurn('s1')
  assert.equal(own.driver('s1'), 'idle')

  const revision = own.observeTurn('s1', 't1').revision
  own.claim('tab-1', 's1')
  assert.equal(own.driver('s1'), 'agent')
  assert.equal(own.tabDriver('tab-1'), 'agent')

  assert.deepEqual(own.turnEnded('s1'), ['tab-1'])
  assert.equal(own.driver('s1'), 'idle')
  // Whatever the turn left running stops at its next checkpoint…
  assert.equal(codeOf(() => own.assertAllowed('s1', revision)), 'OPERATION_ABORTED')
  // …and a straggler that only now arrives on the ended turn is refused, rather
  // than quietly making the session look busy again.
  assert.equal(codeOf(() => own.observeTurn('s1', 't1')), 'OPERATION_ABORTED')
  assert.equal(own.driver('s1'), 'idle')

  // A probe between turns still gets through.
  own.assertAllowed('s1', own.observeTurn('s1').revision)

  const next = own.observeTurn('s1', 't2').revision
  assert.equal(own.driver('s1'), 'agent')
  own.assertAllowed('s1', next)
})

test('a session that never touched the browser has nothing to end', () => {
  const own = new BrowserOwnership()
  assert.deepEqual(own.turnEnded('s1'), [])
  // And its first real turn is not mistaken for a straggler.
  own.observeTurn('s1', 't1')
  assert.equal(own.driver('s1'), 'agent')
})

test('input on an idle session\'s tab only makes its reading stale', () => {
  const own = new BrowserOwnership()
  own.observeTurn('s1', 't1')
  own.claim('tab-1', 's1')
  own.turnEnded('s1')

  assert.equal(own.userInput('tab-1', true), 'stale')
  assert.equal(own.userInput('tab-1', false), 'stale')
  // The button has nothing to stop between turns either.
  assert.equal(own.takeOver('tab-1'), false)
  assert.equal(own.driver('s1'), 'idle')
  assert.equal(own.isBlocked('s1'), false)

  // Nobody owns an untouched tab, so nothing about it is anyone's to forget.
  assert.equal(own.userInput('tab-9', true), 'ignored')
})

test('mid-turn, only a press or a keystroke takes over; a wheel is looking', () => {
  const own = new BrowserOwnership()
  const revision = own.observeTurn('s1', 't1').revision
  own.claim('tab-1', 's1')

  assert.equal(own.userInput('tab-1', false), 'ignored')
  assert.equal(own.driver('s1'), 'agent')
  own.assertAllowed('s1', revision)

  assert.equal(own.userInput('tab-1', true), 'takeover')
  assert.equal(own.driver('s1'), 'user')
  assert.equal(own.tabDriver('tab-1'), 'user')
  assert.equal(codeOf(() => own.assertAllowed('s1', revision)), 'BROWSER_USER_TAKEOVER')
  // Already held: more input changes nothing.
  assert.equal(own.userInput('tab-1', true), 'ignored')
})

test('handing back mid-turn returns to agent; the turn ending returns to idle', () => {
  const own = new BrowserOwnership()
  const revision = own.observeTurn('s1', 't1').revision
  own.claim('tab-1', 's1')

  own.takeOver('tab-1')
  assert.deepEqual(own.release('tab-1'), ['tab-1'])
  assert.equal(own.driver('s1'), 'agent')
  own.assertAllowed('s1', revision)

  // Taken again, and this time the turn just ends: the takeover ends with it.
  own.takeOver('tab-1')
  assert.deepEqual(own.turnEnded('s1'), ['tab-1'])
  assert.equal(own.driver('s1'), 'idle')
  assert.equal(own.isBlocked('s1'), false)
  // So a hand-back after that is a no-op, not a redraw.
  assert.deepEqual(own.release('tab-1'), [])
})

test('the agent closing its own tab is not input either', () => {
  const own = new BrowserOwnership()
  own.observeTurn('s1', 't1')
  own.claim('tab-1', 's1')
  const done = own.expectAgentClose('tab-1')
  assert.equal(own.userInput('tab-1', true), 'ignored')
  done()
  assert.equal(own.userInput('tab-1', true), 'takeover')
})
