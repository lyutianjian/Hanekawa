import assert from 'node:assert/strict'
import test from 'node:test'
import { isMounted, nextPhase, phaseClass, type Phase } from '../src/desktop/renderer/model/presence.js'

const phases: Phase[] = ['closed', 'entering', 'open', 'closing']

test('presence intents and settlements cover both directions in every phase', () => {
  for (const phase of phases) {
    for (const want of [false, true]) {
      assert.equal(nextPhase(phase, want, 'intent'), want
        ? phase === 'open' ? 'open' : 'entering'
        : phase === 'closed' ? 'closed' : 'closing')
      assert.equal(nextPhase(phase, want, 'settled'), phase === 'entering' && want
        ? 'open' : phase === 'closing' && !want ? 'closed' : phase)
    }
    assert.equal(isMounted(phase), phase !== 'closed')
    assert.equal(phaseClass(phase), `presence-${phase}`)
  }
})

test('reversals stay mounted and late or duplicate settlements cannot undo intent', () => {
  let phase: Phase = 'closed'
  for (const want of [true, false, true, false]) {
    phase = nextPhase(phase, want, 'intent')
    assert.equal(isMounted(phase), true)
    assert.equal(nextPhase(phase, !want, 'settled'), phase, 'an old direction is ignored')
  }
  phase = nextPhase(phase, false, 'settled') // fallback wins
  assert.equal(phase, 'closed')
  assert.equal(nextPhase(phase, false, 'settled'), 'closed') // real event arrives later
  assert.equal(nextPhase('open', false, 'settled'), 'open')
})
