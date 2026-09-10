import assert from 'node:assert/strict'
import test from 'node:test'
import { motionFallback, reducedMotion } from '../src/desktop/renderer/model/reducedMotion.js'

test('reduced motion disables spatial work and uses near-immediate settlement', () => {
  for (const matches of [false, true]) {
    const policy = reducedMotion(matches)
    assert.equal(policy.animate, !matches)
    assert.equal(policy.settleImmediately, matches)
    assert.equal(policy.scrollBehavior, 'auto', 'explicit location never leaves a smooth scroll running')
    assert.equal(motionFallback(340, policy.settleImmediately), matches ? 1 : 340)
  }
})
