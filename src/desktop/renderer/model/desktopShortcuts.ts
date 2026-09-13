import type { DesktopPlatform } from '../../types.js'
import type { KeyChord } from './keymap.js'

/** The same labels feed the title bar, sidebar tooltips and shortcut help. */
const SHORTCUTS = {
  'new-session': { key: 'T' },
  'open-project': { key: 'O', shift: true },
  'open-settings': { key: ',' },
  'toggle-sidebar': { key: 'B' },
  'close-session': { key: 'W' },
  'switch-session': { key: '1-9' },
} as const

export type DesktopShortcut = keyof typeof SHORTCUTS

export function desktopShortcut(platform: DesktopPlatform, action: DesktopShortcut): string {
  const chord: { key: string; shift?: boolean } = SHORTCUTS[action]
  return platform === 'darwin'
    ? `${chord.shift ? '⇧' : ''}⌘${chord.key}`
    : `Ctrl+${chord.shift ? 'Shift+' : ''}${chord.key}`
}

/** Only this native menu accelerator conflicts with the renderer's session close. */
export function isMacSessionCloseShortcut(chord: KeyChord): boolean {
  return chord.metaKey === true
    && chord.ctrlKey !== true
    && chord.shiftKey !== true
    && chord.altKey !== true
    && chord.key.toUpperCase() === SHORTCUTS['close-session'].key
}
