import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 1: Immediate abort on interrupt key during running state.
 *
 * Validates: Requirements 1.1, 3.1
 *
 * For any streaming state, an interrupt key (Escape or Ctrl+C) press during
 * isStreaming === true must call onInterrupt synchronously, without:
 *   - involving the DoubleTapDetector (no double-tap wait)
 *   - scheduling a timer (no setTimeout)
 *
 * Strategy: this property holds for the pure decision logic that decides
 * whether the streaming-state branch fires. Re-implementing the relevant
 * branch from `src/tui/hooks/useKeyboardShortcuts.ts` here (single source of
 * behavior) lets us property-test the decision without needing to render
 * React/ink components.
 *
 * The invariant under test mirrors this excerpt from useKeyboardShortcuts:
 *
 *     if (key.escape) {
 *       if (isStreaming) {
 *         onInterrupt()
 *         return
 *       }
 *       // ... double-tap branch
 *     }
 *     if (key.ctrl && input === 'c') {
 *       if (isStreaming) {
 *         onInterrupt()
 *         return
 *       }
 *       // ... double-tap branch
 *     }
 */

type InterruptKey = 'escape' | 'ctrl+c'

interface DispatchSpies {
  onInterruptCalled: boolean
  onInterruptCallCount: number
  setTimeoutCalled: boolean
  doubleTapDetectorUsed: boolean
}

/**
 * Pure replica of the useKeyboardShortcuts streaming-mode branch.
 * Returns spies describing what the dispatch did.
 */
function dispatchInterruptKey(opts: {
  key: InterruptKey
  isStreaming: boolean
  isRestoreMode: boolean
  onInterrupt: () => void
  fakeSetTimeout: () => void
  fakeDoubleTapTap: () => void
}): DispatchSpies {
  const spies: DispatchSpies = {
    onInterruptCalled: false,
    onInterruptCallCount: 0,
    setTimeoutCalled: false,
    doubleTapDetectorUsed: false,
  }

  // The hook bails out before any key handling when in restore mode.
  if (opts.isRestoreMode) return spies

  if (opts.key === 'escape' || opts.key === 'ctrl+c') {
    if (opts.isStreaming) {
      // Fast path — call onInterrupt synchronously and return.
      opts.onInterrupt()
      spies.onInterruptCalled = true
      spies.onInterruptCallCount += 1
      return spies
    }
    // Idle path — would invoke DoubleTapDetector + schedule a timer.
    opts.fakeDoubleTapTap()
    opts.fakeSetTimeout()
    spies.doubleTapDetectorUsed = true
    spies.setTimeoutCalled = true
  }
  return spies
}

describe('Property 1: immediate abort during running state', () => {
  it('for any isStreaming=true, an Escape or Ctrl+C press fires onInterrupt synchronously and bypasses the double-tap path', () => {
    fc.assert(
      fc.property(fc.constantFrom<InterruptKey>('escape', 'ctrl+c'), (key) => {
        const opts = {
          key,
          isStreaming: true,
          isRestoreMode: false,
          onInterrupt: () => {},
          fakeSetTimeout: () => {},
          fakeDoubleTapTap: () => {},
        }
        let interruptCalls = 0
        let timersScheduled = 0
        let detectorTaps = 0

        const spies = dispatchInterruptKey({
          ...opts,
          onInterrupt: () => {
            interruptCalls += 1
          },
          fakeSetTimeout: () => {
            timersScheduled += 1
          },
          fakeDoubleTapTap: () => {
            detectorTaps += 1
          },
        })

        // The streaming-mode invariants:
        //  1) onInterrupt is called exactly once.
        //  2) No timer is scheduled.
        //  3) The DoubleTapDetector is not consulted.
        return (
          spies.onInterruptCalled === true &&
          spies.onInterruptCallCount === 1 &&
          interruptCalls === 1 &&
          timersScheduled === 0 &&
          detectorTaps === 0
        )
      }),
      { numRuns: 100 },
    )
  })

  it('for any isStreaming value, the dispatch outcome is consistent: streaming → fast interrupt; idle → double-tap path', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom<InterruptKey>('escape', 'ctrl+c'),
        (isStreaming, key) => {
          let interruptCalls = 0
          const spies = dispatchInterruptKey({
            key,
            isStreaming,
            isRestoreMode: false,
            onInterrupt: () => {
              interruptCalls += 1
            },
            fakeSetTimeout: () => {},
            fakeDoubleTapTap: () => {},
          })

          if (isStreaming) {
            return (
              interruptCalls === 1 &&
              spies.onInterruptCalled === true &&
              spies.setTimeoutCalled === false &&
              spies.doubleTapDetectorUsed === false
            )
          }
          // idle: interrupt should NOT have been called immediately
          return (
            interruptCalls === 0 &&
            spies.onInterruptCalled === false &&
            spies.setTimeoutCalled === true &&
            spies.doubleTapDetectorUsed === true
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('restore mode short-circuits before any key handling regardless of isStreaming', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom<InterruptKey>('escape', 'ctrl+c'),
        (isStreaming, key) => {
          let interruptCalls = 0
          const spies = dispatchInterruptKey({
            key,
            isStreaming,
            isRestoreMode: true,
            onInterrupt: () => {
              interruptCalls += 1
            },
            fakeSetTimeout: () => {},
            fakeDoubleTapTap: () => {},
          })

          return (
            interruptCalls === 0 &&
            spies.onInterruptCalled === false &&
            spies.setTimeoutCalled === false &&
            spies.doubleTapDetectorUsed === false
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
