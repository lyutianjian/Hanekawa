import { Text } from 'ink'
import { useState, useEffect } from 'react'
import { ThemedText } from '../design-system/ThemedText.js'

export type SpinnerMode = 'thinking' | 'streaming' | 'tool'

const MODE_FRAMES: Record<SpinnerMode, string[]> = {
  thinking: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  streaming: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  tool: ['◐', '◓', '◑', '◒'],
}

const MODE_LABELS: Record<SpinnerMode, string> = {
  thinking: 'Thinking...',
  streaming: 'Streaming...',
  tool: 'Executing tool...',
}

const INTERVAL = 80

interface SpinnerProps {
  label?: string
  startTime?: string
  mode?: SpinnerMode
}

export function Spinner({ label, startTime, mode = 'thinking' }: SpinnerProps) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState('0.0')

  const frames = MODE_FRAMES[mode]
  const displayLabel = label ?? MODE_LABELS[mode]

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length)
      if (startTime) {
        const seconds = (Date.now() - new Date(startTime).getTime()) / 1000
        setElapsed(seconds.toFixed(1))
      }
    }, INTERVAL)
    return () => clearInterval(timer)
  }, [startTime, frames.length])

  return (
    <ThemedText color="spinner">
      {frames[frame]} {displayLabel}
      {startTime && <Text color="dimmed"> ({elapsed}s)</Text>}
    </ThemedText>
  )
}
