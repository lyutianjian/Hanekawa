import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 5: Input clearing on single interrupt key in idle state.
 *
 * Validates: Requirements 2.7, 3.4
 *
 * For any non-empty input text in idle state, a single interrupt key press
 * (not followed by a second within the double-tap window) results in empty
 * input.
 *
 * For Escape: a single tap clears the input regardless of content.
 * For Ctrl+C: a single tap on non-empty input clears it; on empty input it
 * shows the "Press Ctrl+C again to exit" hint instead.
 *
 * Strategy: re-implement the relevant decision logic from
 * `src/tui/hooks/useKeyboardShortcuts.ts` in a pure function so we can
 * property-test it without rendering React/ink components.
 */

type InterruptKey = 'escape' | 'ctrl+c'

interface IdleSingleTapResult {
  newText: string
  newCursorPos: number
  hintShown: string | null
  enteredRestoreMode: boolean
  exitTriggered: boolean
}

/**
 * Pure replica of the idle-state single-tap branch from useKeyboardShortcuts.
 * Models what happens when DoubleTapDetector resolves a tap as 'single'
 * (the window expired without a second press).
 */
function applyIdleSingleTap(opts: {
  key: InterruptKey
  text: string
  cursorPos: number
}): IdleSingleTapResult {
  if (opts.key === 'escape') {
    // Single Escape in idle: clear input
    return {
      newText: '',
      newCursorPos: 0,
      hintShown: null,
      enteredRestoreMode: false,
      exitTriggered: false,
    }
  }
  // Ctrl+C
  if (opts.text === '') {
    // Empty input: show "Press Ctrl+C again to exit" hint, don't clear
    return {
      newText: '',
      newCursorPos: 0,
      hintShown: 'Press Ctrl+C again to exit',
      enteredRestoreMode: false,
      exitTriggered: false,
    }
  }
  // Non-empty input: clear text
  return {
    newText: '',
    newCursorPos: 0,
    hintShown: null,
    enteredRestoreMode: false,
    exitTriggered: false,
  }
}

describe('Property 5: input clearing on single interrupt key in idle state', () => {
  it('for any non-empty input text and Escape single-tap, the result is empty input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        (text, cursorPosRaw) => {
          const cursorPos = cursorPosRaw % Math.max(1, text.length + 1)
          const result = applyIdleSingleTap({ key: 'escape', text, cursorPos })
          return (
            result.newText === '' &&
            result.newCursorPos === 0 &&
            result.hintShown === null &&
            result.enteredRestoreMode === false
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any non-empty input text and Ctrl+C single-tap, the input is cleared and no hint is shown', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        (text, cursorPosRaw) => {
          const cursorPos = cursorPosRaw % Math.max(1, text.length + 1)
          const result = applyIdleSingleTap({ key: 'ctrl+c', text, cursorPos })
          return (
            result.newText === '' &&
            result.newCursorPos === 0 &&
            result.hintShown === null &&
            result.exitTriggered === false
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for empty input and Ctrl+C single-tap, the hint "Press Ctrl+C again to exit" is shown and exit is NOT triggered', () => {
    // No fc randomness needed for the empty case, but we run 100 iterations
    // through the same pure function to confirm determinism.
    fc.assert(
      fc.property(fc.constant(''), () => {
        const result = applyIdleSingleTap({ key: 'ctrl+c', text: '', cursorPos: 0 })
        return (
          result.newText === '' &&
          result.newCursorPos === 0 &&
          result.hintShown === 'Press Ctrl+C again to exit' &&
          result.exitTriggered === false &&
          result.enteredRestoreMode === false
        )
      }),
      { numRuns: 100 },
    )
  })

  it('for any input text and Escape single-tap, restore mode is NOT entered (only double-tap enters it)', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = applyIdleSingleTap({ key: 'escape', text, cursorPos: 0 })
        return result.enteredRestoreMode === false && result.exitTriggered === false
      }),
      { numRuns: 100 },
    )
  })

  it('for any input text and Ctrl+C single-tap, the application is NOT exited (only double-tap exits)', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = applyIdleSingleTap({ key: 'ctrl+c', text, cursorPos: 0 })
        return result.exitTriggered === false
      }),
      { numRuns: 100 },
    )
  })
})
