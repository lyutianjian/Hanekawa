import React, { type PropsWithChildren, useInsertionEffect } from 'react'
import {
  Box,
  useStdout,
  restoreInkFrameForStdout,
  snapshotInkFrameForStdout,
  suspendInkStaticOutputForStdout,
} from '../ink.js'
import type { InkFrameSnapshot } from '../ink.js'

const ENTER_ALT_SCREEN = '\x1B[?1049h'
const EXIT_ALT_SCREEN = '\x1B[?1049l'
const CLEAR_SCREEN = '\x1B[2J'
const CURSOR_HOME = '\x1B[H'

interface AlternateScreenProps {
  promptFrameSnapshot?: InkFrameSnapshot
}

export function AlternateScreen({
  children,
  promptFrameSnapshot,
}: PropsWithChildren<AlternateScreenProps>) {
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 24

  useInsertionEffect(() => {
    const promptFrame = promptFrameSnapshot ?? snapshotInkFrameForStdout(stdout)
    suspendInkStaticOutputForStdout(stdout)
    stdout.write(ENTER_ALT_SCREEN + CLEAR_SCREEN + CURSOR_HOME)
    return () => {
      stdout.write(EXIT_ALT_SCREEN)
      restoreInkFrameForStdout(stdout, promptFrame)
    }
  }, [stdout, promptFrameSnapshot])

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}
