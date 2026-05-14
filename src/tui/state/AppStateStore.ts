import type { ThemeSetting } from '../design-system/theme.js'

export type AppState = {
  themeSetting: ThemeSetting
  isRunning: boolean
  activeOverlays: Set<string>
  activeKeybindingContext: string
  verbose: boolean
}

export function getDefaultAppState(): AppState {
  return {
    themeSetting: 'dark',
    isRunning: false,
    activeOverlays: new Set(),
    activeKeybindingContext: 'Chat',
    verbose: false,
  }
}
