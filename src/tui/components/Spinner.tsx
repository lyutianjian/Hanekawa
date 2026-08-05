import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Box, Text, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { TaskDisplaySnapshot } from '../../harness/types.js'
import { useSpinner } from '../hooks/useSpinner.js'
import { theme } from '../theme.js'
import { ResponseBlock } from './ResponseBlock.js'
import { TaskListBlock } from './TaskListBlock.js'

const DIM_COLOR = theme.dimText
const FALLBACK_GRAY = { r: 128, g: 128, b: 128 }
const DEFAULT_CHARACTERS = getDefaultCharacters()
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()]
const GLIMMER_PADDING = 10
const ACTIVE_TOOL_FLASH_MS = 1000
const SPINNER_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  "Beboppin'",
  'Befuddling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Bunning',
  'Burrowing',
  'Calculating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Cerebrating',
  'Channeling',
  'Channelling',
  'Choreographing',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Dilly-dallying',
  'Discombobulating',
  'Doing',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Envisioning',
  'Evaporating',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambeeing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Gitifying',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honking',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Ionizing',
  'Jitterbugging',
  'Julienning',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Metamorphosing',
  'Misting',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Nebulizing',
  'Nesting',
  'Newspapering',
  'Noodling',
  'Nucleating',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Photosynthesizing',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Processing',
  'Proofing',
  'Propagating',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Recombobulating',
  'Reticulating',
  'Roosting',
  'Ruminating',
  'Sauteing',
  'Scampering',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Sublimating',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Working',
  'Wrangling',
  'Zesting',
  'Zigzagging',
] as const

interface SpinnerProps {
  subText?: string
  mode?: StreamSpinnerMode
  taskSnapshot?: TaskDisplaySnapshot
  spinnerColors?: SpinnerColors
  active?: boolean
  responseLengthRef?: RefObject<number>
}

export interface SpinnerColors {
  messageColor: string
  shimmerColor: string
}

export function Spinner({ subText, mode: streamMode = 'requesting', taskSnapshot, spinnerColors, active = true, responseLengthRef }: SpinnerProps) {
  const [randomVerb] = useState(() => `${sampleSpinnerVerb()}...`)
  const [sampledSpinnerColors] = useState(sampleSpinnerColors)
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null)
  const thinkingStartRef = useRef<number | null>(null)
  const { messageColor, shimmerColor } = spinnerColors ?? sampledSpinnerColors
  const { stdout } = useStdout()
  const { frame, elapsed, time } = useSpinner(active)

  const hasActiveTool = Boolean(subText)
  const mode: SpinnerMode = hasActiveTool ? 'tool-use' : streamMode

  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | undefined
    let clearStatusTimer: ReturnType<typeof setTimeout> | undefined

    if (mode === 'thinking') {
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now()
      }
      setThinkingStatus('thinking')
    } else if (thinkingStartRef.current !== null) {
      const duration = Date.now() - thinkingStartRef.current
      const remainingThinkingTime = Math.max(0, 2_000 - duration)
      thinkingStartRef.current = null

      const showDuration = () => {
        setThinkingStatus(duration)
        clearStatusTimer = setTimeout(() => setThinkingStatus(null), 2_000)
      }

      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime)
      } else {
        showDuration()
      }
    }

    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer)
      if (clearStatusTimer) clearTimeout(clearStatusTimer)
    }
  }, [mode])

  if (!active) return null

  const elapsedText = formatElapsed(elapsed)
  const terminalWidth = stdout.columns || 80

  // Build parenthetical: (elapsed · ↓ tokens · thinking status)
  const approxTokens = responseLengthRef ? Math.round(responseLengthRef.current / 4) : 0
  const parentheticalSegments: string[] = [elapsedText]
  if (approxTokens > 0) parentheticalSegments.push(`↓ ${formatTokenCount(approxTokens)}`)
  const thinkingLabel = formatThinkingStatus(thinkingStatus)
  if (thinkingLabel) parentheticalSegments.push(thinkingLabel)
  const parenthetical = parentheticalSegments.join(' · ')

  const parentheticalWidth = stringWidth(parenthetical) + 4 // "(" + ")" + spaces
  const messageWidth = Math.max(1, terminalWidth - parentheticalWidth - 2)
  const taskMessage = taskSnapshot ? formatActiveTaskMessage(taskSnapshot) : undefined
  // Always show random verb as main message — never "Thinking..."
  const message = hasActiveTool
    ? truncateMiddleByWidth(subText!, messageWidth)
    : mode === 'waiting'
      ? 'Waiting for model...'
      : truncateMiddleByWidth(taskMessage ?? randomVerb, messageWidth)
  const glimmerIndex = getGlimmerIndex(message, mode, time)
  const flashOpacity = mode === 'tool-use'
    ? (Math.sin((time / ACTIVE_TOOL_FLASH_MS) * Math.PI) + 1) / 2
    : 0

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" flexWrap="wrap" width="100%">
        <SpinnerGlyph frame={frame} messageColor={messageColor} />
        <GlimmerMessage
          message={message}
          mode={mode}
          messageColor={messageColor}
          glimmerIndex={glimmerIndex}
          flashOpacity={flashOpacity}
          shimmerColor={shimmerColor}
        />
        <Text color={DIM_COLOR}>(</Text>
        <Text color={DIM_COLOR}>{parenthetical}</Text>
        <Text color={DIM_COLOR}>)</Text>
      </Box>
      {taskSnapshot && taskSnapshot.counts.total > 0 && (
        <ResponseBlock>
          <TaskListBlock
            snapshot={taskSnapshot}
            showHeader={false}
            runningColor={messageColor}
            animationsEnabled={active}
          />
        </ResponseBlock>
      )}
    </Box>
  )
}

type StreamSpinnerMode = 'requesting' | 'thinking' | 'waiting'
type SpinnerMode = StreamSpinnerMode | 'tool-use'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60 > 0 ? ` ${seconds % 60}s` : ''}`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h${m > 0 ? ` ${m}m` : ''}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`
  return `${tokens} tokens`
}

function formatThinkingStatus(status: 'thinking' | number | null): string | undefined {
  if (status === 'thinking') return 'thinking'
  if (typeof status === 'number') return `thought for ${Math.max(1, Math.round(status / 1000))}s`
  return undefined
}

function SpinnerGlyph({
  frame,
  messageColor,
}: {
  frame: number
  messageColor: string
}): ReactNode {
  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!
  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={messageColor}>{spinnerChar}</Text>
    </Box>
  )
}

function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
}: {
  message: string
  mode: SpinnerMode
  messageColor: string
  glimmerIndex: number
  flashOpacity: number
  shimmerColor: string
}): ReactNode {
  if (!message) return null

  const baseColor = parseHexColor(messageColor)
  const shimmerRGB = parseHexColor(shimmerColor)

  if (mode === 'tool-use') {
    const color = toRGBColor(interpolateColor(baseColor, shimmerRGB, flashOpacity))
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  const segments = getGraphemeSegments(message)
  const messageWidth = stringWidth(message)
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

function getGlimmerIndex(message: string, mode: SpinnerMode, time: number): number {
  const glimmerSpeed = mode === 'requesting' ? 50 : 200
  const messageWidth = stringWidth(message)
  const cycleLength = messageWidth + GLIMMER_PADDING * 2
  const cyclePosition = Math.floor(time / glimmerSpeed)

  if (mode === 'requesting') {
    return (cyclePosition % cycleLength) - GLIMMER_PADDING
  }
  return messageWidth + GLIMMER_PADDING - (cyclePosition % cycleLength)
}

function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['\u00b7', '\u2722', '\u2733', '\u2736', '\u273b', '*']
  }
  return process.platform === 'darwin'
    ? ['\u00b7', '\u2722', '\u2733', '\u2736', '\u273b', '\u273d']
    : ['\u00b7', '\u2722', '*', '\u2736', '\u273b', '\u273d']
}

function getGraphemeSegments(value: string): Array<{ value: string; width: number }> {
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined
  const parts = segmenter
    ? [...segmenter.segment(value)].map((part) => part.segment)
    : [...value]
  return parts.map((part) => ({ value: part, width: stringWidth(part) }))
}

function sampleSpinnerVerb(): string {
  const index = Math.floor(Math.random() * SPINNER_VERBS.length)
  return SPINNER_VERBS[index] ?? 'Thinking'
}

export function sampleSpinnerColors(): SpinnerColors {
  const palette = theme.spinnerPalette
  const index = Math.floor(Math.random() * palette.length)
  const colors = palette[index]
  return {
    messageColor: colors?.base ?? theme.spinner,
    shimmerColor: colors?.shimmer ?? theme.spinner,
  }
}

function truncateMiddleByWidth(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value
  const ellipsis = '...'
  const target = Math.max(1, maxWidth - stringWidth(ellipsis))
  const segments = getGraphemeSegments(value)
  let head = ''
  let tail = ''
  let headWidth = 0
  let tailWidth = 0
  let left = 0
  let right = segments.length - 1

  while (left <= right && headWidth + tailWidth < target) {
    const takeHead = headWidth <= tailWidth
    if (takeHead) {
      const segment = segments[left]
      if (!segment || headWidth + tailWidth + segment.width > target) break
      head += segment.value
      headWidth += segment.width
      left++
    } else {
      const segment = segments[right]
      if (!segment || headWidth + tailWidth + segment.width > target) break
      tail = segment.value + tail
      tailWidth += segment.width
      right--
    }
  }

  return `${head}${ellipsis}${tail}`
}

function interpolateColor(
  color1: RGBColor,
  color2: RGBColor,
  t: number,
): RGBColor {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

function parseHexColor(value: string): RGBColor {
  const normalized = value.startsWith('#') ? value.slice(1) : value
  if (normalized.length !== 6) return FALLBACK_GRAY
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function toRGBColor(color: RGBColor): string {
  return `rgb(${color.r},${color.g},${color.b})`
}

interface RGBColor {
  r: number
  g: number
  b: number
}

function formatActiveTaskMessage(snapshot: TaskDisplaySnapshot): string | undefined {
  const active = snapshot.activeTaskId
    ? snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)
    : snapshot.tasks.find((task) => task.status === 'in_progress')
  if (!active) return undefined
  const label = active.activeForm ?? active.subject
  return label.endsWith('...') ? label : `${label}...`
}
