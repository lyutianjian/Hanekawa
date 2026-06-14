import React, { type PropsWithChildren, useInsertionEffect } from 'react'
import { Box, useStdout, resetLogUpdateForStdout } from '../ink.js'

const ENTER_ALT_SCREEN = '\x1B[?1049h'
const EXIT_ALT_SCREEN = '\x1B[?1049l'
const CLEAR_SCREEN = '\x1B[2J'
const CURSOR_HOME = '\x1B[H'

export function AlternateScreen({ children }: PropsWithChildren) {
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? 24

  useInsertionEffect(() => {
    stdout.write(ENTER_ALT_SCREEN + CLEAR_SCREEN + CURSOR_HOME)
    return () => {
      // 1. Exit alternate screen — terminal is back to pre-alt-screen state.
      stdout.write(EXIT_ALT_SCREEN)
      // 2. Clear the main screen and home cursor — blank canvas at (0,0).
      stdout.write(CLEAR_SCREEN + CURSOR_HOME)
      // 3. Reset ink's log-update state — clear stale previousLineCount,
      //    cursorWasShown, and previousCursorPosition from the transcript view.
      //    After this, log-update thinks the screen is empty (0 previous lines),
      //    so the next render writes from (0,0) without erasing anything.
      resetLogUpdateForStdout(stdout)
    }
  }, [stdout])

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      {children}
    </Box>
  )
}
