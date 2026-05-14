// 新 TUI 入口点

import React from 'react'
import { render } from '../ink.js'
import { AppStateProvider } from '../state/AppState.js'
import { REPL } from '../screens/REPL.js'

async function main() {
  render(
    <AppStateProvider>
      <REPL />
    </AppStateProvider>,
  )
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
