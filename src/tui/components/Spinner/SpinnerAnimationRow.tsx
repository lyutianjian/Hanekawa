import React from 'react'
import { Box, Text } from 'ink'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useAnimationFrame } from '../../hooks/useAnimationFrame.js'

type SpinnerMode = 'thinking' | 'streaming' | 'tool'

type Props = {
  mode: SpinnerMode
  message?: string
  stalledIntensity?: number
  reducedMotion?: boolean
}

const MODE_VERBS: Record<SpinnerMode, string> = {
  thinking: 'Thinking',
  streaming: 'Responding',
  tool: 'Using tools',
}

export function SpinnerAnimationRow({ mode, message, stalledIntensity = 0, reducedMotion }: Props) {
  const frame = useAnimationFrame(reducedMotion ? 1000 : 50)

  const verb = message || MODE_VERBS[mode]
  const elapsedS = Math.floor(frame * 0.05)

  return (
    <Box flexDirection="row">
      <SpinnerGlyph frame={frame} stalledIntensity={stalledIntensity} />
      <Text> </Text>
      <Text color={stalledIntensity > 0.5 ? 'red' : 'cyan'}>{verb}</Text>
      <Text dimColor> · {elapsedS}s</Text>
    </Box>
  )
}
