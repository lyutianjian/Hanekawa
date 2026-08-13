import { createContext, useEffect, useState, type ReactNode } from 'react'
import { useTerminalFocus } from '../hooks/useTerminalFocus.js'
import { DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING } from './terminalFocusState.js'

export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  setTickInterval: (ms: number) => void
}

export const FRAME_INTERVAL_MS = 16
const BLURRED_TICK_INTERVAL_MS = FRAME_INTERVAL_MS * 2

// Port of Claude Code's ClockContext: a single global setInterval (≈60fps)
// that only runs while at least one keepAlive subscriber is mounted, with a
// per-tick snapshot so all subscribers in the same tick see the same value.
export function createClock(tickIntervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>()
  let interval: ReturnType<typeof setInterval> | null = null
  let currentTickIntervalMs = tickIntervalMs
  let startTime = 0
  let tickTime = 0

  function tick(): void {
    tickTime = Date.now() - startTime
    for (const onChange of subscribers.keys()) {
      onChange()
    }
  }

  function updateInterval(): void {
    const anyKeepAlive = [...subscribers.values()].some(Boolean)
    if (anyKeepAlive) {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
      if (startTime === 0) {
        startTime = Date.now()
      }
      interval = setInterval(tick, currentTickIntervalMs)
    } else if (interval) {
      clearInterval(interval)
      interval = null
    }
  }

  return {
    subscribe(onChange, keepAlive) {
      subscribers.set(onChange, keepAlive)
      updateInterval()
      return () => {
        subscribers.delete(onChange)
        updateInterval()
      }
    },
    now() {
      if (startTime === 0) {
        startTime = Date.now()
      }
      // When the clock interval is running, return the synchronized tickTime
      // so all subscribers in the same tick see the same value.
      // When paused (no keepAlive subscribers), return real-time so no
      // subscriber ever reads a stale tickTime from the last tick.
      if (interval && tickTime) {
        return tickTime
      }
      return Date.now() - startTime
    },
    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) return
      currentTickIntervalMs = ms
      updateInterval()
    },
  }
}

export const ClockContext = createContext<Clock | null>(null)

// Own component so consumers don't re-render when the clock is created.
// The clock value is stable (created once via useState), so the provider
// never causes consumer re-renders on its own.
export function ClockProvider({ children }: { children: ReactNode }): ReactNode {
  const [clock] = useState(() => createClock(FRAME_INTERVAL_MS))
  const focused = useTerminalFocus()

  useEffect(() => {
    clock.setTickInterval(focused ? FRAME_INTERVAL_MS : BLURRED_TICK_INTERVAL_MS)
  }, [clock, focused])

  // Enable DECSET 1004 focus reporting only after render so the escape bytes
  // can never reach the readline trust prompts that run before the TUI.
  useEffect(() => {
    if (!process.stdout.isTTY) return
    process.stdout.write(ENABLE_FOCUS_REPORTING)
    return () => {
      process.stdout.write(DISABLE_FOCUS_REPORTING)
    }
  }, [])

  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}