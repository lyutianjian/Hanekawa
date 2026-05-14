import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

/**
 * Shared animation clock - all animated components share a single setInterval.
 * This prevents N components from creating N independent timers.
 * Aligned with Claude Code's ClockContext pattern.
 */

interface ClockListener {
  onChange: () => void
  keepAlive: boolean
}

interface Clock {
  time: number
  subscribe(listener: () => void, keepAlive: boolean): () => void
}

function createClock(): Clock {
  let time = 0
  let intervalId: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<ClockListener>()
  const TICK_MS = 50

  function tick() {
    time += TICK_MS
    for (const listener of listeners) {
      listener.onChange()
    }
    // If no listeners remain, stop the timer to save CPU
    if (listeners.size === 0 && intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  function ensureRunning() {
    if (!intervalId) {
      intervalId = setInterval(tick, TICK_MS)
    }
  }

  return {
    get time() {
      return time
    },
    subscribe(onChange: () => void, keepAlive: boolean): () => void {
      const listener: ClockListener = { onChange, keepAlive }
      listeners.add(listener)
      ensureRunning()
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const ClockContext = createContext<Clock | null>(null)

interface ClockProviderProps {
  children: ReactNode
}

export function ClockProvider({ children }: ClockProviderProps) {
  const clockRef = useRef<Clock | null>(null)
  if (!clockRef.current) {
    clockRef.current = createClock()
  }

  return (
    <ClockContext.Provider value={clockRef.current}>
      {children}
    </ClockContext.Provider>
  )
}

/**
 * Hook that returns the current animation time, updating at the specified interval.
 * Uses the shared ClockContext so all animated components are synchronized.
 *
 * @param intervalMs - Update interval in milliseconds. Pass null to pause.
 * @returns The current time in milliseconds since the clock started.
 */
export function useAnimationFrame(intervalMs: number | null): number {
  const clock = useContext(ClockContext)
  const [time, setTime] = useState(0)

  useEffect(() => {
    if (!clock || intervalMs === null) return

    // Throttle updates to the requested interval
    let lastUpdateTime = 0
    const unsubscribe = clock.subscribe(() => {
      const now = clock.time
      if (now - lastUpdateTime >= intervalMs) {
        lastUpdateTime = now
        setTime(now)
      }
    }, false)

    return unsubscribe
  }, [clock, intervalMs])

  if (!clock || intervalMs === null) return 0
  return time
}

/**
 * Get the shared clock instance for imperative access.
 * Useful when you need to read time without subscribing to updates.
 */
export function useClock(): Clock | null {
  return useContext(ClockContext)
}

/**
 * Simple interval hook that uses the shared clock.
 * Returns the current tick count.
 */
export function useInterval(callback: () => void, ms: number | null): void {
  const clock = useContext(ClockContext)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!clock || ms === null) return

    let lastTick = 0
    const unsubscribe = clock.subscribe(() => {
      const now = clock.time
      if (now - lastTick >= ms) {
        lastTick = now
        callbackRef.current()
      }
    }, false)

    return unsubscribe
  }, [clock, ms])
}
