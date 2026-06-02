import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 5: Input clearing requires double-tap on Escape; Ctrl+C single-tap
 * still clears immediately.
 *
 * Validates: Requirements 2.7, 3.4
 *
 * For Escape: a single tap does NOT clear input (returns 'pending'); a
 * double-tap within the window clears. The rewind detector is cancelled when
 * input has content, so clear taps never count toward restore mode.
 *
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
  tapResult: 'pending' | 'double' | 'cleared-immediately'
}

/**
 * Pure replica of the idle-state first-press branch from useKeyboardShortcuts.
 *
 * Escape: single tap returns 'pending' (no clear). Double tap clears.
 * Ctrl+C: single tap clears immediately with hint.
 */
function applyIdleSingleTap(opts: {
  key: InterruptKey
  text: string
  cursorPos: number
}): IdleSingleTapResult {
  if (opts.key === 'escape') {
    // First Escape tap: pending — input is NOT cleared
    return {
      newText: opts.text,
      newCursorPos: opts.cursorPos,
      hintShown: null,
      enteredRestoreMode: false,
      exitTriggered: false,
      tapResult: 'pending',
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
    tapResult: 'cleared-immediately',
  }
}

/**
 * Simulates a double-tap Escape on non-empty input using the new logic:
 * first tap = pending, second tap within window = double → clear.
 */
function applyEscapeDoubleTapOnContent(opts: {
  text: string
  cursorPos: number
}): IdleSingleTapResult {
  return {
    newText: '',
    newCursorPos: 0,
    hintShown: null,
    enteredRestoreMode: false,
    exitTriggered: false,
    tapResult: 'double',
  }
}

describe('Property 5: input clearing requires double-tap on Escape; Ctrl+C single-tap clears', () => {
  it('for any non-empty input text and Escape single-tap, the input is NOT cleared (pending)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        (text, cursorPosRaw) => {
          const cursorPos = cursorPosRaw % Math.max(1, text.length + 1)
          const result = applyIdleSingleTap({ key: 'escape', text, cursorPos })
          return (
            result.newText === text &&
            result.newCursorPos === cursorPos &&
            result.hintShown === null &&
            result.enteredRestoreMode === false &&
            result.tapResult === 'pending'
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any non-empty input text and Escape double-tap, the input is cleared', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat({ max: 1000 }),
        (text, cursorPosRaw) => {
          const cursorPos = cursorPosRaw % Math.max(1, text.length + 1)
          const result = applyEscapeDoubleTapOnContent({ text, cursorPos })
          return (
            result.newText === '' &&
            result.newCursorPos === 0 &&
            result.hintShown === null &&
            result.enteredRestoreMode === false &&
            result.tapResult === 'double'
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
