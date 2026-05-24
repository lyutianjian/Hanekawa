import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { DoubleTapDetector } from '../src/tui/utils/doubleTapDetector.js'

/**
 * Unit tests for DoubleTapDetector.
 *
 * These tests use real timers with brief waits. The window is kept at the
 * minimum allowed (100ms) so the suite stays fast.
 */

describe('DoubleTapDetector', () => {
  it('returns "double" when second tap arrives within the window (200ms < 300ms)', () => {
    const detector = new DoubleTapDetector({ windowMs: 300 })
    try {
      // First tap → 'pending'
      const first = detector.tap('escape', () => {
        assert.fail('onSingle should not be called when a double-tap is detected')
      })
      assert.equal(first, 'pending')

      // Simulate a 200ms gap. We can't directly advance Date.now() here, so we
      // use the detector's own timing. The detector compares against Date.now()
      // captured during tap(); a second tap fired immediately after the first
      // is well within 300ms, which models the "200ms interval" case.
      const second = detector.tap('escape', () => {
        assert.fail('onSingle should not be called when a double-tap is detected')
      })
      assert.equal(second, 'double')
    } finally {
      detector.dispose()
    }
  })

  it('treats taps separated by >= window as two singles (400ms > 300ms with 100ms window)', async () => {
    // Use the smallest allowed window (100ms) so the test runs quickly.
    const detector = new DoubleTapDetector({ windowMs: 100 })
    let singleCount = 0
    try {
      const first = detector.tap('escape', () => {
        singleCount++
      })
      assert.equal(first, 'pending')

      // Wait long enough for the first tap's window to fully expire.
      // This models a 400ms gap when the window is 300ms — past the threshold.
      await delay(150)
      assert.equal(singleCount, 1, 'first tap should have fired its onSingle callback')

      const second = detector.tap('escape', () => {
        singleCount++
      })
      assert.equal(second, 'pending', 'second tap (after window) should be a fresh single, not a double')

      await delay(150)
      assert.equal(singleCount, 2, 'second tap should also fire its onSingle callback')
    } finally {
      detector.dispose()
    }
  })

  it('cancel() clears the pending timer so onSingle is never invoked', async () => {
    const detector = new DoubleTapDetector({ windowMs: 100 })
    let singleCalled = false
    try {
      const result = detector.tap('escape', () => {
        singleCalled = true
      })
      assert.equal(result, 'pending')

      detector.cancel()

      // Wait past the window — onSingle must NOT fire.
      await delay(150)
      assert.equal(singleCalled, false, 'onSingle should not be called after cancel()')
    } finally {
      detector.dispose()
    }
  })

  it('cancel() resets state so the next tap starts a fresh sequence', async () => {
    const detector = new DoubleTapDetector({ windowMs: 100 })
    try {
      detector.tap('escape', () => {})
      detector.cancel()

      // After cancel, an immediate tap should be a fresh 'pending', not 'double'.
      let singleCalled = false
      const next = detector.tap('escape', () => {
        singleCalled = true
      })
      assert.equal(next, 'pending')

      await delay(150)
      assert.equal(singleCalled, true, 'onSingle should fire for the post-cancel tap')
    } finally {
      detector.dispose()
    }
  })

  it('dispose() clears any pending timer (no late callback)', async () => {
    const detector = new DoubleTapDetector({ windowMs: 100 })
    let singleCalled = false

    detector.tap('escape', () => {
      singleCalled = true
    })

    detector.dispose()

    await delay(150)
    assert.equal(singleCalled, false, 'onSingle should not fire after dispose()')
  })

  it('different keys do not form a double-tap', async () => {
    const detector = new DoubleTapDetector({ windowMs: 100 })
    let singleCount = 0
    try {
      detector.tap('escape', () => {
        singleCount++
      })
      const second = detector.tap('ctrl-c', () => {
        singleCount++
      })
      assert.equal(second, 'pending', 'pressing a different key should not register as a double-tap')

      await delay(150)
      // The first 'escape' timer was cleared when 'ctrl-c' arrived, so only the
      // ctrl-c single-tap callback should fire.
      assert.equal(singleCount, 1)
    } finally {
      detector.dispose()
    }
  })

  it('falls back to default 300ms window for invalid configurations', async () => {
    // Negative value → invalid → falls back to 300ms default.
    const detector = new DoubleTapDetector({ windowMs: -50 })
    let singleCalled = false
    try {
      detector.tap('escape', () => {
        singleCalled = true
      })
      // Wait 150ms — well under the 300ms default, so onSingle should NOT have fired yet.
      await delay(150)
      assert.equal(singleCalled, false, 'onSingle should not fire before the default 300ms window')

      // Wait the rest of the way past 300ms.
      await delay(200)
      assert.equal(singleCalled, true, 'onSingle should fire after the default 300ms window')
    } finally {
      detector.dispose()
    }
  })
})
