import { useSyncExternalStore } from 'react'
import { getTerminalFocused, subscribeTerminalFocus } from '../clock/terminalFocusState.js'

/**
 * Whether the terminal currently has focus (DECSET 1004 focus reporting).
 * Unknown terminals default to focused so animations never throttle.
 */
export function useTerminalFocus(): boolean {
  return useSyncExternalStore(subscribeTerminalFocus, getTerminalFocused)
}