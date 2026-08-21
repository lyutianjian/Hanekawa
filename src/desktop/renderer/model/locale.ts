import type { Locale } from '../../../runtime/locale.js'

/**
 * The language this shell speaks.
 *
 * Stage-4 decision 5: the desktop app is Chinese and the TUI stays English.
 * Spelled once here rather than as a `'zh'` literal at each of the dozen
 * presentation call sites — the shared modules default to `'en'`, so a call
 * that forgets the argument is silently English rather than broken, which is
 * exactly the kind of miss a scattered literal produces.
 */
export const UI_LOCALE: Locale = 'zh'
