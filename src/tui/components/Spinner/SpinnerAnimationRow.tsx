import { useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'
import stringWidth from 'string-width'
import { useAnimationFrame } from '../../hooks/useAnimationFrame.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import type { SpinnerMode } from './types.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { formatElapsed, formatTokenCount, interpolateColor, toRGBColor } from './utils.js'

const SEP_WIDTH = stringWidth(' · ')
const THINKING_BARE_WIDTH = stringWidth('thinking')
const SHOW_TOKENS_AFTER_MS = 30_000

// Thinking shimmer constants (previously a separate sub-component with its own
// 50ms clock) — inlined to reuse this row's existing frame.
const THINKING_INACTIVE = { r: 153, g: 153, b: 153 }
const THINKING_INACTIVE_SHIMMER = { r: 185, g: 185, b: 185 }
const THINKING_DELAY_MS = 3000
const THINKING_GLOW_PERIOD_S = 2

export interface SpinnerAnimationRowProps {
  // Animation inputs
  mode: SpinnerMode
  hasActiveTools: boolean
  responseLengthRef: RefObject<number>

  // Message (stable within a turn)
  message: string
  messageColor: string
  shimmerColor: string

  // Timer refs (stable references)
  loadingStartTimeRef: RefObject<number>
  totalPausedMsRef: RefObject<number>
  pauseStartTimeRef: RefObject<number | null>

  // Thinking (state owned by parent, mode-dependent)
  thinkingStatus: 'thinking' | number | null
  columns: number
}

/**
 * The 50ms-animated portion of the spinner. Owns useAnimationFrame(50) and
 * every value derived from the animation clock (glyph frame, glimmer, token
 * counter animation, elapsed time, stalled intensity, thinking shimmer).
 *
 * The parent Spinner shell is freed from the 50ms render loop and only
 * re-renders when its props state change (~25x/turn instead of ~383x), which
 * keeps the verb selection, TaskListBlock, and thinking timers out of the hot
 * animation path. Ported from Claude Code's SpinnerAnimationRow.
 */
export function SpinnerAnimationRow({
  mode,
  hasActiveTools,
  responseLengthRef,
  message,
  messageColor,
  shimmerColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  thinkingStatus,
  columns,
}: SpinnerAnimationRowProps): ReactNode {
  const time = useAnimationFrame(50)

  // === Elapsed time (wall-clock, derived from refs each frame) ===
  const now = Date.now()
  const loadingStartTime = loadingStartTimeRef.current ?? now
  const elapsedTimeMs = pauseStartTimeRef.current !== null
    ? pauseStartTimeRef.current - loadingStartTime - totalPausedMsRef.current
    : now - loadingStartTime - totalPausedMsRef.current

  // === Animation derivations from `time` ===
  const currentResponseLength = responseLengthRef.current
  const { isStalled, stalledIntensity } = useStalledAnimation(
    time,
    currentResponseLength,
    hasActiveTools,
  )
  const frame = Math.floor(time / 120)
  const glimmerSpeed = mode === 'requesting' ? 50 : 200
  // message is stable within a turn; stringWidth is memoized explicitly
  // across the 50ms loop.
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message])
  const cycleLength = glimmerMessageWidth + 20
  const cyclePosition = Math.floor(time / glimmerSpeed)
  const glimmerIndex = isStalled
    ? -100
    : mode === 'requesting'
      ? (cyclePosition % cycleLength) - 10
      : glimmerMessageWidth + 10 - (cyclePosition % cycleLength)
  const flashOpacity = mode === 'tool-use'
    ? (Math.sin((time / 1000) * Math.PI) + 1) / 2
    : 0

  // === Token counter animation (smooth increment, driven by the 50ms clock) ===
  const tokenCounterRef = useRef(currentResponseLength)
  const gap = currentResponseLength - tokenCounterRef.current
  if (gap > 0) {
    const increment = gap < 70
      ? 3
      : gap < 200
        ? Math.max(8, Math.ceil(gap * 0.15))
        : 50
    tokenCounterRef.current = Math.min(tokenCounterRef.current + increment, currentResponseLength)
  }
  const tokens = Math.round(tokenCounterRef.current / 4)

  const timerText = formatElapsed(Math.floor(elapsedTimeMs / 1000))
  const timerWidth = stringWidth(timerText)
  const modeArrow = figures[mode === 'requesting' ? 'arrowUp' : 'arrowDown']
  const tokensText = `${mode === 'waiting' ? '' : modeArrow}${mode === 'waiting' ? '' : ' '}${formatTokenCount(tokens)}`
  const tokensWidth = stringWidth(tokensText)

  // === Thinking text (may shrink to fit) ===
  let thinkingText: string | null = thinkingStatus === 'thinking'
    ? 'thinking'
    : typeof thinkingStatus === 'number'
      ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
      : null
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0

  // === Progressive width gating ===
  const messageWidth = glimmerMessageWidth + 2
  const sep = SEP_WIDTH
  const wantsThinking = thinkingStatus !== null
  const wantsTimerAndTokens = elapsedTimeMs > SHOW_TOKENS_AFTER_MS
  const availableSpace = columns - messageWidth - 5
  let showThinking = wantsThinking && availableSpace > thinkingWidthValue
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking' && availableSpace > THINKING_BARE_WIDTH) {
    thinkingText = 'thinking'
    thinkingWidthValue = THINKING_BARE_WIDTH
    showThinking = true
  }
  const usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0
  const showTimer = wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0)
  const showTokens = wantsTimerAndTokens && tokens > 0 && availableSpace > usedAfterTimer + tokensWidth

  // === Thinking shimmer color (formerly its own 50ms subscriber) ===
  const thinkingElapsedSec = (time - THINKING_DELAY_MS) / 1000
  const thinkingOpacity = time < THINKING_DELAY_MS
    ? 0
    : (Math.sin((thinkingElapsedSec * Math.PI * 2) / THINKING_GLOW_PERIOD_S) + 1) / 2
  const thinkingShimmerColor = toRGBColor(
    interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity),
  )

  // === Build status parts ===
  const timerTokenText = [
    ...(showTimer ? [timerText] : []),
    ...(showTokens ? [tokensText] : []),
  ].join(' · ')
  const showThinkingSegment = showThinking && thinkingText !== null
  const hasStatus = timerTokenText.length > 0 || showThinkingSegment

  return (
    <Box flexDirection="row" flexWrap="wrap" width="100%">
      <SpinnerGlyph frame={frame} messageColor={messageColor} stalledIntensity={stalledIntensity} />
      <GlimmerMessage
        message={message}
        mode={mode}
        messageColor={messageColor}
        glimmerIndex={glimmerIndex}
        flashOpacity={flashOpacity}
        shimmerColor={shimmerColor}
        stalledIntensity={stalledIntensity}
      />
      {hasStatus && (
        <>
          <Text dimColor>(</Text>
          {timerTokenText.length > 0 && <Text dimColor>{timerTokenText}</Text>}
          {timerTokenText.length > 0 && showThinkingSegment && <Text dimColor> · </Text>}
          {showThinkingSegment && (
            thinkingStatus === 'thinking'
              ? <Text color={thinkingShimmerColor}>{thinkingText}</Text>
              : <Text dimColor>{thinkingText}</Text>
          )}
          <Text dimColor>)</Text>
        </>
      )}
    </Box>
  )
}