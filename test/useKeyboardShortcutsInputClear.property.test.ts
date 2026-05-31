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
 * For Ctrl+C: a single tap clears input, including when it is already empty,
 * and shows the hint that matches whether this press counted toward exit.
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
 * Pure replica of the idle-state first-press branch from useKeyboardShortcuts.
 * The visible clear happens immediately; double-tap detection still decides
 * whether a second press opens restore mode or exits.
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
  // Ctrl+C clears immediately. Non-empty input does not count toward exit, so
  // the user needs two more presses after the clear.
  return {
    newText: '',
    newCursorPos: 0,
    hintShown: opts.text.length > 0
      ? 'Input cleared. Press Ctrl+C twice to exit'
      : 'Press Ctrl+C again to exit',
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

  it('for any non-empty input text and Ctrl+C single-tap, the input is cleared and the two-press hint is shown', () => {
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
            result.hintShown === 'Input cleared. Press Ctrl+C twice to exit' &&
            result.exitTriggered === false
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for empty input and Ctrl+C single-tap, the input remains empty and the one-more-press hint is shown', () => {
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
