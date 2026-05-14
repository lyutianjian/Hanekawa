import React, { useRef } from 'react'
import { Box } from 'ink'
import { SpinnerAnimationRow } from './SpinnerAnimationRow.js'
import { useStalledAnimation } from '../../hooks/useStalledAnimation.js'

type SpinnerMode = 'thinking' | 'streaming' | 'tool'

type Props = {
  mode: SpinnerMode
  message?: string
  responseLengthRef?: React.RefObject<number>
  reducedMotion?: boolean
}

export function SpinnerWithVerb({ mode, message, responseLengthRef, reducedMotion }: Props) {
  const fallbackRef = useRef(0)
  const lengthRef = responseLengthRef ?? fallbackRef

  const { isStalled, intensity } = useStalledAnimation({
    responseLengthRef: lengthRef,
  })

  return (
    <Box marginBottom={1}>
      <SpinnerAnimationRow
        mode={mode}
        message={message}
        stalledIntensity={isStalled ? intensity : 0}
        reducedMotion={reducedMotion}
      />
    </Box>
  )
}
