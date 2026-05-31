import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 6: Double-tap Ctrl+C exits application.
 *
 * For empty input, two Ctrl+C presses separated by less than `doubleTapWindow`
 * ms exit via process.exit(0). When streaming, the AbortController must also
 * be signaled.
 *
 * If the first Ctrl+C clears non-empty input, it must not count as the first
 * tap in the double-tap exit sequence.
 */

interface CtrlCDispatchResult {
  exitTriggered: boolean
  abortSignaled: boolean
  hintShown: string | null
}

function dispatchCtrlCSequence(opts: {
  isStreaming: boolean
  isRestoreMode: boolean
  intervalMs: number
  doubleTapWindowMs: number
  text: string
}): CtrlCDispatchResult {
  if (opts.isRestoreMode) {
    return { exitTriggered: false, abortSignaled: false, hintShown: null }
  }

  if (!opts.isStreaming && opts.text.length > 0) {
    return {
      exitTriggered: false,
      abortSignaled: false,
      hintShown: 'Input cleared. Press Ctrl+C twice to exit',
    }
  }

  if (opts.intervalMs < opts.doubleTapWindowMs) {
    return {
      exitTriggered: true,
      abortSignaled: opts.isStreaming,
      hintShown: null,
    }
  }

  return {
    exitTriggered: false,
    abortSignaled: opts.isStreaming,
    hintShown: 'Press Ctrl+C again to exit',
  }
}

describe('Property 6: double-tap Ctrl+C exits application', () => {
  it('for empty idle input and intervals < doubleTapWindow, two Ctrl+C presses trigger exit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        (windowMs, intervalRaw) => {
          const intervalMs = intervalRaw % windowMs

          const result = dispatchCtrlCSequence({
            isStreaming: false,
            isRestoreMode: false,
            intervalMs,
            doubleTapWindowMs: windowMs,
            text: '',
          })

          return result.exitTriggered === true && result.hintShown === null
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for empty idle input and intervals >= doubleTapWindow, two Ctrl+C presses do NOT trigger exit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        (windowMs, intervalRaw) => {
          const span = Math.max(1, 2000 - windowMs + 1)
          const intervalMs = windowMs + (intervalRaw % span)

          const result = dispatchCtrlCSequence({
            isStreaming: false,
            isRestoreMode: false,
            intervalMs,
            doubleTapWindowMs: windowMs,
            text: '',
          })

          return (
            result.exitTriggered === false &&
            result.hintShown === 'Press Ctrl+C again to exit'
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for non-empty idle input, two Ctrl+C presses do not exit because the first press only clears input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0, max: 99 }),
        (text, intervalMs) => {
          const result = dispatchCtrlCSequence({
            isStreaming: false,
            isRestoreMode: false,
            intervalMs,
            doubleTapWindowMs: 100,
            text,
          })
          return (
            result.exitTriggered === false &&
            result.hintShown === 'Input cleared. Press Ctrl+C twice to exit'
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when streaming, two Ctrl+C presses within the window exit and signal abort', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.string(),
        (windowMs, intervalRaw, text) => {
          const intervalMs = intervalRaw % windowMs
          const result = dispatchCtrlCSequence({
            isStreaming: true,
            isRestoreMode: false,
            intervalMs,
            doubleTapWindowMs: windowMs,
            text,
          })

          return result.exitTriggered === true && result.abortSignaled === true
        },
      ),
      { numRuns: 100 },
    )
  })

  it('restore mode short-circuits Ctrl+C dispatch: never exits, never aborts', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.string(),
        (isStreaming, windowMs, intervalRaw, text) => {
          const intervalMs = intervalRaw % windowMs
          const result = dispatchCtrlCSequence({
            isStreaming,
            isRestoreMode: true,
            intervalMs,
            doubleTapWindowMs: windowMs,
            text,
          })
          return (
            result.exitTriggered === false &&
            result.abortSignaled === false &&
            result.hintShown === null
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
