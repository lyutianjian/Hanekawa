import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import {
  ERROR_RED,
  getDefaultCharacters,
  interpolateColor,
  parseHexColor,
  toRGBColor,
} from './utils.js'

const SPINNER_FRAMES = [...getDefaultCharacters(), ...[...getDefaultCharacters()].reverse()]

export function SpinnerGlyph({
  frame,
  messageColor,
  stalledIntensity = 0,
}: {
  frame: number
  messageColor: string
  stalledIntensity?: number
}): ReactNode {
  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!

  // Smoothly interpolate from current color to red when stalled
  if (stalledIntensity > 0) {
    const interpolated = interpolateColor(parseHexColor(messageColor), ERROR_RED, stalledIntensity)
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={toRGBColor(interpolated)}>{spinnerChar}</Text>
      </Box>
    )
  }

  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={messageColor}>{spinnerChar}</Text>
    </Box>
  )
}