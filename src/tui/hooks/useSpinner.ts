import { useEffect, useRef, useState } from 'react'

const TICK_MS = 50

export function useSpinner() {
  const [time, setTime] = useState(0)
  const startTimeRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    startTimeRef.current = Date.now()
    setTime(0)
    setElapsed(0)

    const id = setInterval(() => {
      const now = Date.now()
      const nextTime = now - startTimeRef.current
      setTime(nextTime)
      setElapsed(Math.floor(nextTime / 1000))
    }, TICK_MS)

    return () => clearInterval(id)
  }, [])

  return {
    frame: Math.floor(time / 120),
    elapsed,
    time,
  }
}
