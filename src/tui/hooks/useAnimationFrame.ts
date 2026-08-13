import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../clock/ClockContext.js'

/**
 * Animation time derived from the shared ClockContext.
 *
 * All callers share one global setInterval; each subscriber rate-limits
 * itself ([intervalMs]) and buffers its own time. The clock only runs while
 * at least one animation is mounted (keepAlive semantics), and slows down
 * when the terminal loses focus.
 *
 * Pass `null` to pause — unsubscribes from the clock and freezes time at
 * its last value.
 *
 * Without a ClockProvider (e.g. unit tests) this returns the initial value
 * and never ticks, so consumers just render statically.
 *
 * @param intervalMs - how often to update, or null to pause
 * @returns elapsed animation time in ms since the clock started
 */
export function useAnimationFrame(intervalMs: number | null = 16): number {
  const clock = useContext(ClockContext)
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  useEffect(() => {
    if (!clock || intervalMs === null) return

    let lastUpdate = clock.now()
    const onChange = (): void => {
      const now = clock.now()
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive: true — visible animations drive the clock
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs])

  return time
}