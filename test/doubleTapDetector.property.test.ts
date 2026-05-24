import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import fc from 'fast-check'
import { DoubleTapDetector } from '../src/tui/utils/doubleTapDetector.js'

/**
 * Feature: keyboard-shortcuts-control, Property 2: Double-tap timing detection for Escape
 *
 * Validates: Requirements 2.1, 2.7
 *
 * For any two consecutive key presses in idle state:
 *   - if the interval between them is < windowMs, the second tap result is 'double'
 *   - if the interval between them is >= windowMs, the second tap result is NOT 'double'
 *
 * The DoubleTapDetector uses real Date.now() and setTimeout, so we use node:test's
 * mock.timers to deterministically control elapsed time between simulated taps.
 */
describe('DoubleTapDetector — Property 2: double-tap timing', () => {
  it('for any interval < windowMs between two consecutive same-key taps, the second tap returns "double"', () => {
    fc.assert(
      fc.property(
        // windowMs in valid configurable range [100, 1000] (integer)
        fc.integer({ min: 100, max: 1000 }),
        // interval in [0, 2000]ms; we'll filter to interval < windowMs inside the predicate
        fc.integer({ min: 0, max: 2000 }),
        (windowMs, intervalRaw) => {
          // Constrain interval to the "fast" branch: strictly less than windowMs.
          // Using modulo keeps the input space dense for shrinking while staying in range.
          const interval = intervalRaw % windowMs // [0, windowMs - 1]

          mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
          try {
            const detector = new DoubleTapDetector({ windowMs })
            let onSingleCalled = false
            const onSingle = () => {
              onSingleCalled = true
            }

            // First tap → 'pending', timer scheduled for windowMs ticks from now
            const first = detector.tap('escape', onSingle)
            assert.strictEqual(first, 'pending')

            // Advance virtual time by `interval` ms (strictly less than windowMs)
            mock.timers.tick(interval)

            // Second tap of same key within window → 'double'
            const second = detector.tap('escape', onSingle)

            // The single-tap callback must NOT have been invoked when a double is detected
            // (the pending timer is cleared on detection).
            const passed = second === 'double' && !onSingleCalled
            detector.dispose()
            return passed
          } finally {
            mock.timers.reset()
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any interval >= windowMs between two consecutive same-key taps, the second tap result is NOT "double"', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        (windowMs, intervalRaw) => {
          // Constrain interval to the "slow" branch: >= windowMs and within [0, 2000].
          // Map raw input into [windowMs, 2000] by clamping/shifting.
          const span = Math.max(1, 2000 - windowMs + 1)
          const interval = windowMs + (intervalRaw % span) // [windowMs, 2000]

          mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
          try {
            const detector = new DoubleTapDetector({ windowMs })
            let onSingleCalled = false
            const onSingle = () => {
              onSingleCalled = true
            }

            // First tap → 'pending', timer scheduled for windowMs ticks from now
            const first = detector.tap('escape', onSingle)
            assert.strictEqual(first, 'pending')

            // Advance virtual time by `interval` ms; this crosses the window boundary,
            // so the pending timer fires and the single-tap callback is invoked.
            mock.timers.tick(interval)

            // Second tap of the same key after the window — must NOT be 'double'.
            const second = detector.tap('escape', onSingle)

            const passed = second !== 'double' && (onSingleCalled as boolean) === true
            detector.dispose()
            return passed
          } finally {
            mock.timers.reset()
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
