import type { ThemeSetting } from '../design-system/theme.js'

export type PendingPermission = {
  toolName: string
  input: unknown
  reason: string
  riskLevel: 'safe' | 'confirm' | 'dangerous'
  resolve: (approved: boolean) => void
  onAlwaysAllow?: () => void
}

export type AppState = {
  themeSetting: ThemeSetting
  isRunning: boolean
  activeOverlays: Set<string>
  activeKeybindingContext: string
  verbose: boolean
  pendingPermission: PendingPermission | null
}

export function getDefaultAppState(): AppState {
  return {
    themeSetting: 'dark',
    isRunning: false,
    activeOverlays: new Set(),
    activeKeybindingContext: 'Chat',
    verbose: false,
    pendingPermission: null,
  }
}
