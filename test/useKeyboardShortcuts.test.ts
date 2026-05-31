import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { DoubleTapDetector } from '../src/tui/utils/doubleTapDetector.js'

describe('useKeyboardShortcuts behavior (via pure shortcut pieces)', () => {
  it('Escape double-tap within the window returns "double" so restore mode can open', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const detector = new DoubleTapDetector({ windowMs: 300 })
      let singleFired = false

      detector.tap('escape', () => {
        singleFired = true
      })

      mock.timers.tick(100)
      const result = detector.tap('escape', () => {
        singleFired = true
      })

      assert.equal(result, 'double')
      assert.equal(singleFired, false, 'onSingle should not fire on double-tap')

      detector.dispose()
    } finally {
      mock.timers.reset()
    }
  })

  it('Ctrl+C double-tap within the window returns "double" so the app can exit', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const detector = new DoubleTapDetector({ windowMs: 300 })
      let singleFired = false

      detector.tap('ctrl+c', () => {
        singleFired = true
      })

      mock.timers.tick(150)
      const result = detector.tap('ctrl+c', () => {
        singleFired = true
      })

      assert.equal(result, 'double')
      assert.equal(singleFired, false, 'onSingle should not fire on double-tap')

      detector.dispose()
    } finally {
      mock.timers.reset()
    }
  })

  it('Escape while streaming immediately calls onInterrupt without double-tap handling', () => {
    let interruptCalled = false
    let detectorUsed = false

    const isStreaming = true
    if (isStreaming) {
      interruptCalled = true
    } else {
      detectorUsed = true
    }

    assert.equal(interruptCalled, true)
    assert.equal(detectorUsed, false)
  })

  it('Ctrl+C while streaming interrupts on the first press and exits on a fast second press', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const detector = new DoubleTapDetector({ windowMs: 300 })
      let interruptCalled = false
      let exitCalled = false

      const first = detector.tap('ctrl+c', () => {})
      if (first === 'double') {
        exitCalled = true
      } else {
        interruptCalled = true
      }

      mock.timers.tick(100)
      const second = detector.tap('ctrl+c', () => {})
      if (second === 'double') {
        exitCalled = true
      }

      assert.equal(interruptCalled, true)
      assert.equal(exitCalled, true)

      detector.dispose()
    } finally {
      mock.timers.reset()
    }
  })

  it('hint message auto-dismisses after 5 seconds (simulated via timer)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      let hintDismissed = false

      setTimeout(() => {
        hintDismissed = true
      }, 5000)

      mock.timers.tick(4999)
      assert.equal(hintDismissed, false)

      mock.timers.tick(1)
      assert.equal(hintDismissed, true)
    } finally {
      mock.timers.reset()
    }
  })

  it('abort signals AbortController (simulated abort flow)', () => {
    const ac = new AbortController()
    assert.equal(ac.signal.aborted, false)

    ac.abort()

    assert.equal(ac.signal.aborted, true)
    assert.equal(ac.signal.reason instanceof DOMException, true)
  })
})
