/**
 * Theme preference resolution — pure, DOM-free.
 *
 * The renderer resolves a stored preference to a concrete theme and writes it to
 * `document.documentElement.dataset.theme`; the stylesheet then overrides tokens
 * under `:root[data-theme="light"]`. "Follow the system" is resolved here in JS
 * rather than in CSS (`@media`), so the sheet stays a flat set of token blocks.
 *
 * This module takes primitives only (strings, a boolean) so it can be unit-tested
 * without a DOM. The `matchMedia`/`localStorage`/`document` wiring lives in
 * `app.ts`; `rendererImports.test.ts` forbids browser globals here.
 */

export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'
export type SystemTheme = 'dark' | 'light'

/** The key `app.ts` reads and writes in `localStorage`. */
export const THEME_STORAGE_KEY = 'ui-theme'

/** No stored choice means follow the system. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/** Selectable preferences, in the order the appearance picker offers them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light']

/** The sole interpreter of `localStorage['ui-theme']`: junk/null/unknown → the default. */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME_PREFERENCE
}

/** The whole resolution rule: an explicit choice wins, `system` defers to the OS. */
export function resolveTheme(preference: ThemePreference, system: SystemTheme): ResolvedTheme {
  return preference === 'system' ? system : preference
}

/** Only `system` cares about a `prefers-color-scheme` change. */
export function followsSystem(preference: ThemePreference): boolean {
  return preference === 'system'
}

/** `matchMedia('(prefers-color-scheme: dark)').matches` → a concrete system theme. */
export function systemThemeFromMatches(matches: boolean): SystemTheme {
  return matches ? 'dark' : 'light'
}
