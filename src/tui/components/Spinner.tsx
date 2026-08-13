import { useEffect, useRef, useState, type RefObject } from 'react'
import stringWidth from 'string-width'
import { Box, useStdout } from 'ink'
import type { TaskDisplaySnapshot } from '../../harness/types.js'
import { theme } from '../theme.js'
import { ResponseBlock } from './ResponseBlock.js'
import { TaskListBlock } from './TaskListBlock.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import type { SpinnerMode } from './Spinner/types.js'
import { getGraphemeSegments } from './Spinner/utils.js'

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
  loadingStartTimeRef?: RefObject<number>
  totalPausedMsRef?: RefObject<number>
  pauseStartTimeRef?: RefObject<number | null>
}

export interface SpinnerColors {
  messageColor: string
  shimmerColor: string
}

type StreamSpinnerMode = 'requesting' | 'thinking' | 'tool-input' | 'tool-use' | 'responding' | 'waiting'

// Static shell of the spinner. Only SpinnerAnimationRow subscribes to the
// global animation clock; this component re-renders solely on state/prop
// changes (~25x/turn instead of ~383x at 50ms), keeping verb selection, the
// thinking timers, and TaskListBlock out of the animation path.
export function Spinner({
  subText,
  mode: streamMode = 'requesting',
  taskSnapshot,
  spinnerColors,
  active = true,
  responseLengthRef,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
}: SpinnerProps) {
  const [randomVerb] = useState(() => `${sampleSpinnerVerb()}...`)
  const [sampledSpinnerColors] = useState(sampleSpinnerColors)
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null)
  const thinkingStartRef = useRef<number | null>(null)
  const { messageColor, shimmerColor } = spinnerColors ?? sampledSpinnerColors
  const { stdout } = useStdout()

  // Fallbacks keep the props optional for callers that only pass taskSnapshot
  // (tests, static TaskListBlock rendering) — App passes the real refs.
  const fallbackLoadingStartRef = useRef(Date.now())
  const fallbackTotalPausedMsRef = useRef(0)
  const fallbackPauseStartRef = useRef<number | null>(null)
  const fallbackResponseLengthRef = useRef(0)
  const rowLoadingStartRef = loadingStartTimeRef ?? fallbackLoadingStartRef
  const rowTotalPausedMsRef = totalPausedMsRef ?? fallbackTotalPausedMsRef
  const rowPauseStartRef = pauseStartTimeRef ?? fallbackPauseStartRef
  const rowResponseLengthRef = responseLengthRef ?? fallbackResponseLengthRef

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

  // Pause accounting: while the spinner is hidden (overlays like the
  // permission dialog), freeze the elapsed clock and resume it on return.
  useEffect(() => {
    if (active) {
      if (rowPauseStartRef.current !== null) {
        rowTotalPausedMsRef.current += Date.now() - rowPauseStartRef.current
        rowPauseStartRef.current = null
      }
    } else if (rowPauseStartRef.current === null) {
      rowPauseStartRef.current = Date.now()
    }
  }, [active, rowPauseStartRef, rowTotalPausedMsRef])

  if (!active) return null

  const terminalWidth = stdout.columns || 80
  const taskMessage = taskSnapshot ? formatActiveTaskMessage(taskSnapshot) : undefined
  const message = hasActiveTool
    ? truncateMiddleByWidth(subText!, Math.max(1, terminalWidth - 2))
    : mode === 'waiting'
      ? 'Waiting for model...'
      : truncateMiddleByWidth(taskMessage ?? randomVerb, Math.max(1, terminalWidth - 2))

  return (
    <Box flexDirection="column" width="100%">
      <SpinnerAnimationRow
        mode={mode}
        hasActiveTools={hasActiveTool}
        responseLengthRef={rowResponseLengthRef}
        message={message}
        messageColor={messageColor}
        shimmerColor={shimmerColor}
        loadingStartTimeRef={rowLoadingStartRef}
        totalPausedMsRef={rowTotalPausedMsRef}
        pauseStartTimeRef={rowPauseStartRef}
        thinkingStatus={thinkingStatus}
        columns={terminalWidth}
      />
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

function formatActiveTaskMessage(snapshot: TaskDisplaySnapshot): string | undefined {
  const active = snapshot.activeTaskId
    ? snapshot.tasks.find((task) => task.id === snapshot.activeTaskId)
    : snapshot.tasks.find((task) => task.status === 'in_progress')
  if (!active) return undefined
  const label = active.activeForm ?? active.subject
  return label.endsWith('...') ? label : `${label}...`
}