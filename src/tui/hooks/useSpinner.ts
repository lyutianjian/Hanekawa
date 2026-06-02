import { useEffect, useRef, useState } from 'react'

const TICK_MS = 50

export function useSpinner(active = true) {
  const [time, setTime] = useState(0)
  const visibleElapsedMsRef = useRef(0)
  const activeStartedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) return

    activeStartedAtRef.current = Date.now()
    setTime(visibleElapsedMsRef.current)

    const id = setInterval(() => {
      const activeStartedAt = activeStartedAtRef.current
      if (activeStartedAt === null) return
      setTime(visibleElapsedMsRef.current + Date.now() - activeStartedAt)
    }, TICK_MS)

    return () => {
      clearInterval(id)
      const activeStartedAt = activeStartedAtRef.current
      if (activeStartedAt !== null) {
        visibleElapsedMsRef.current += Date.now() - activeStartedAt
        activeStartedAtRef.current = null
      }
    }
  }, [active])

  return {
    frame: Math.floor(time / 120),
    elapsed: Math.floor(time / 1000),
    time,
  }
}
