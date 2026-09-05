import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MARQUEE_GAP,
  MARQUEE_MIN_SHIFT,
  MARQUEE_SPEED,
  marqueeMotion,
} from '../src/desktop/renderer/model/marquee.js'

/**
 * The sidebar's hover marquee, as arithmetic.
 *
 * The view measures two numbers off the element and applies the answer; every
 * decision worth holding still is here. The two load-bearing ones: the distance
 * is exactly one copy plus one gap — anything else leaves a visible jump where
 * the loop restarts — and the speed is the same for every name, which is what a
 * fixed duration would quietly destroy.
 */

test('a title that fits does not marquee', () => {
  assert.equal(marqueeMotion(200, 200), undefined)
  assert.equal(marqueeMotion(180, 200), undefined, 'nor one with room to spare')
})

test('an overhang under the threshold is a rounding artefact, not a scroll', () => {
  assert.equal(marqueeMotion(200 + MARQUEE_MIN_SHIFT - 1, 200), undefined)
  assert.notEqual(marqueeMotion(200 + MARQUEE_MIN_SHIFT, 200), undefined, 'the threshold itself moves')
})

test('an unmeasurable row does not marquee rather than throwing', () => {
  // Both numbers come straight off the element, and a row inside a folded group
  // has no layout at all. Zero width is a row that does not scroll, not an error.
  assert.equal(marqueeMotion(0, 0), undefined)
  assert.equal(marqueeMotion(Number.NaN, 200), undefined)
  assert.equal(marqueeMotion(400, Number.POSITIVE_INFINITY), undefined)
})

test('the loop travels one copy plus one gap, so its restart is invisible', () => {
  // The seam is the whole difficulty of a looping marquee: at exactly this offset
  // the second copy occupies the pixels the first started on, so the frame the
  // animation restarts from is the frame it just drew. A distance derived from
  // the *overhang* instead would jump by whatever the row happened to be wide.
  const motion = marqueeMotion(560, 200)
  assert.equal(motion?.shift, `-${560 + MARQUEE_GAP}px`)
})

test('the scroll runs at one speed whatever the name’s length', () => {
  // The invariant a fixed duration would break, and the reason there is no cap on
  // the duration: an even, ignorable drift is the effect. A long name comes
  // around less often — it does not scroll faster.
  const speedOf = (contentWidth: number): number => {
    const motion = marqueeMotion(contentWidth, 200)
    assert.ok(motion, `${contentWidth}px must marquee`)
    const distance = Math.abs(Number.parseInt(motion.shift, 10))
    return distance / (Number.parseInt(motion.duration, 10) / 1000)
  }
  for (const contentWidth of [210, 400, 900, 4000]) {
    assert.ok(
      Math.abs(speedOf(contentWidth) - MARQUEE_SPEED) < 1,
      `${contentWidth}px scrolls at ${speedOf(contentWidth).toFixed(1)}px/s, not ${MARQUEE_SPEED}`,
    )
  }
})

test('the motion is CSS, so the view never formats a unit', () => {
  const motion = marqueeMotion(560, 200)
  assert.match(motion?.shift ?? '', /^-\d+px$/)
  assert.match(motion?.duration ?? '', /^\d+ms$/)
})
