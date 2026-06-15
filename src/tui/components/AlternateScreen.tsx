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
const ENABLE_ALT_SCROLL = '\x1B[?1007h'
const DISABLE_ALT_SCROLL = '\x1B[?1007l'
const ENABLE_SGR_MOUSE = '\x1B[?1006h'
const DISABLE_SGR_MOUSE = '\x1B[?1006l'
const ENABLE_MOUSE_TRACKING = '\x1B[?1000h'
const DISABLE_MOUSE_TRACKING = '\x1B[?1000l'
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
    stdout.write(
      ENTER_ALT_SCREEN
      + ENABLE_ALT_SCROLL
      + ENABLE_SGR_MOUSE
      + ENABLE_MOUSE_TRACKING
      + CLEAR_SCREEN
      + CURSOR_HOME,
    )
    return () => {
      stdout.write(
        DISABLE_MOUSE_TRACKING
        + DISABLE_SGR_MOUSE
        + DISABLE_ALT_SCROLL
        + EXIT_ALT_SCREEN,
      )
      restoreInkFrameForStdout(stdout, promptFrame)
    }
  }, [stdout, promptFrameSnapshot])

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}
