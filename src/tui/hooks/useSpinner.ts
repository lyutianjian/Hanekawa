import { useState, useEffect, useRef } from 'react'

// Claude Code style: 6 base characters, ping-pong for 12 frames
const BASE_CHARACTERS = process.platform === 'darwin'
  ? ['·', '✢', '✳', '✶', '✻', '✽']
  : ['·', '✢', '*', '✶', '✻', '✽']

const SPINNER_FRAMES = [...BASE_CHARACTERS, ...[...BASE_CHARACTERS].reverse()]

const TICK_MS = 50
const FRAME_DURATION_MS = 120
const GLIMMER_SPEED_MS = 200
const GLIMMER_WINDOW = 3

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
      setTime(now - startTimeRef.current)
      setElapsed(Math.floor((now - startTimeRef.current) / 1000))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  const frame = Math.floor(time / FRAME_DURATION_MS) % SPINNER_FRAMES.length
  const spinnerChar = SPINNER_FRAMES[frame]

  // Glimmer: traveling highlight across "Thinking... Ns"
  const glimmerCycleLength = 30 // approximate message width + buffer
  const cyclePosition = Math.floor(time / GLIMMER_SPEED_MS)
  const glimmerIndex = cyclePosition % glimmerCycleLength

  return {
    frame: spinnerChar,
    glimmerIndex,
    glimmerWindow: GLIMMER_WINDOW,
    elapsed,
    time,
  }
}
