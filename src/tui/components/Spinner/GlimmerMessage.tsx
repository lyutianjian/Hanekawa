import { useMemo, type ReactNode } from 'react'
import { Text } from 'ink'
import stringWidth from 'string-width'
import type { SpinnerMode } from './types.js'
import {
  ERROR_RED,
  getGraphemeSegments,
  interpolateColor,
  parseHexColor,
  toRGBColor,
} from './utils.js'

export function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
  stalledIntensity = 0,
}: {
  message: string
  mode: SpinnerMode
  messageColor: string
  glimmerIndex: number
  flashOpacity: number
  shimmerColor: string
  stalledIntensity?: number
}): ReactNode {
  // Grapheme segmentation and stringWidth are memoized per message so the
  // 50ms animation frame does not re-split the text every tick.
  const { segments, messageWidth } = useMemo(() => {
    return { segments: getGraphemeSegments(message), messageWidth: stringWidth(message) }
  }, [message])

  if (!message) return null

  // Stalled: whole message fades to red, no shimmer.
  if (stalledIntensity > 0) {
    const color = toRGBColor(interpolateColor(parseHexColor(messageColor), ERROR_RED, stalledIntensity))
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    )
  }

  // Tool-use: 1Hz sine pulse between message and shimmer color.
  if (mode === 'tool-use') {
    const color = toRGBColor(
      interpolateColor(parseHexColor(messageColor), parseHexColor(shimmerColor), flashOpacity),
    )
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shim = ''
  let after = ''

  for (const segment of segments) {
    if (colPos + segment.width <= clampedStart) {
      before += segment.value
    } else if (colPos > shimmerEnd) {
      after += segment.value
    } else {
      shim += segment.value
    }
    colPos += segment.width
  }

  return (
    <>
      {before && <Text color={messageColor}>{before}</Text>}
      <Text color={shimmerColor}>{shim}</Text>
      {after && <Text color={messageColor}>{after}</Text>}
      <Text color={messageColor}> </Text>
    </>
  )
}