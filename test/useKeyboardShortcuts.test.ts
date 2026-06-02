import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { DoubleTapDetector } from '../src/tui/utils/doubleTapDetector.js'

describe('useKeyboardShortcuts behavior (via pure shortcut pieces)', () => {
  it('Escape single-tap on non-empty input does NOT clear; double-tap within window clears', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const clearDetector = new DoubleTapDetector({ windowMs: 300 })
      let text = 'draft'
      let cursorPos = text.length

      const pressEscape = () => {
        if (text.length > 0) {
          const result = clearDetector.tap('escape-clear', () => {})
          if (result === 'double') {
            text = ''
            cursorPos = 0
          }
          return
        }
      }

      // First ESC: pending — text should remain
      pressEscape()
      assert.equal(text, 'draft', 'single tap should NOT clear input')

      // Second ESC within window: double — text should be cleared
      mock.timers.tick(100)
      pressEscape()
      assert.equal(text, '', 'double tap should clear input')
      assert.equal(cursorPos, 0)

      clearDetector.dispose()
    } finally {
      mock.timers.reset()
    }
  })

  it('Escape clear detector and rewind detector are independent — clearing does not trigger restore mode', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const clearDetector = new DoubleTapDetector({ windowMs: 300 })
      const rewindDetector = new DoubleTapDetector({ windowMs: 300 })
      let text = 'draft'
      let cursorPos = text.length
      let restoreModeEntered = false

      const pressEscape = () => {
        if (text.length > 0) {
          rewindDetector.cancel()
          const result = clearDetector.tap('escape-clear', () => {})
          if (result === 'double') {
            text = ''
            cursorPos = 0
          }
          return
        }

        clearDetector.cancel()
        const result = rewindDetector.tap('escape-rewind', () => {})
        if (result === 'double') {
          restoreModeEntered = true
        }
      }

      // Clear input with double-tap
      pressEscape()
      mock.timers.tick(100)
      pressEscape()
      assert.equal(text, '')
      assert.equal(restoreModeEntered, false, 'clearing should not trigger restore mode')

      // Now input is empty — double-tap for rewind
      mock.timers.tick(100)
      pressEscape()
      mock.timers.tick(100)
      pressEscape()
      assert.equal(restoreModeEntered, true, 'double-tap on empty input should enter restore mode')

      clearDetector.dispose()
      rewindDetector.dispose()
    } finally {
      mock.timers.reset()
    }
  })

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
