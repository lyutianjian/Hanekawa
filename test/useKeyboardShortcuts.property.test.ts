import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 1: Immediate abort on interrupt key during running state.
 *
 * For any streaming state, an interrupt key (Escape or Ctrl+C) press during
 * isStreaming === true must call onInterrupt synchronously. Escape bypasses
 * double-tap handling; Ctrl+C still enters the double-tap detector so a second
 * press can exit.
 */

type InterruptKey = 'escape' | 'ctrl+c'

interface DispatchSpies {
  onInterruptCalled: boolean
  onInterruptCallCount: number
  setTimeoutCalled: boolean
  doubleTapDetectorUsed: boolean
}

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

  if (opts.isRestoreMode) return spies

  if (opts.key === 'escape') {
    if (opts.isStreaming) {
      opts.onInterrupt()
      spies.onInterruptCalled = true
      spies.onInterruptCallCount += 1
      return spies
    }
    opts.fakeDoubleTapTap()
    opts.fakeSetTimeout()
    spies.doubleTapDetectorUsed = true
    spies.setTimeoutCalled = true
    return spies
  }

  opts.fakeDoubleTapTap()
  opts.fakeSetTimeout()
  spies.doubleTapDetectorUsed = true
  spies.setTimeoutCalled = true
  if (opts.isStreaming) {
    opts.onInterrupt()
    spies.onInterruptCalled = true
    spies.onInterruptCallCount += 1
  }
  return spies
}

describe('Property 1: immediate abort during running state', () => {
  it('for any isStreaming=true, an Escape or Ctrl+C press fires onInterrupt synchronously', () => {
    fc.assert(
      fc.property(fc.constantFrom<InterruptKey>('escape', 'ctrl+c'), (key) => {
        let interruptCalls = 0
        let timersScheduled = 0
        let detectorTaps = 0

        const spies = dispatchInterruptKey({
          key,
          isStreaming: true,
          isRestoreMode: false,
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

        const expectedDoubleTapPathCalls = key === 'ctrl+c' ? 1 : 0
        return (
          spies.onInterruptCalled === true &&
          spies.onInterruptCallCount === 1 &&
          interruptCalls === 1 &&
          timersScheduled === expectedDoubleTapPathCalls &&
          detectorTaps === expectedDoubleTapPathCalls
        )
      }),
      { numRuns: 100 },
    )
  })

  it('for any isStreaming value, the dispatch outcome is consistent for Escape and Ctrl+C', () => {
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
              spies.setTimeoutCalled === (key === 'ctrl+c') &&
              spies.doubleTapDetectorUsed === (key === 'ctrl+c')
            )
          }

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
