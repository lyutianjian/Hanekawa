import { useEffect, useState } from 'react'

/**
 * Blink hook used by tool-call and tool-group status dots.
 * Returns `true` while the dot should be hidden this frame, toggling every
 * 500ms while `enabled` is true. When `enabled` is false the dot stays
 * visible (no blink) and the internal state resets.
 */
export function useBlink(enabled: boolean): boolean {
  const [off, setOff] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setOff(false)
      return
    }
    const timer = setInterval(() => setOff((current) => !current), 500)
    return () => clearInterval(timer)
  }, [enabled])
  return enabled && off
}
