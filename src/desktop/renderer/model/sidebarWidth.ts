/**
 * The sidebar's width: a preference, as data.
 *
 * The rail used to be a hard 280px in two places (`#sidebar`'s `flex-basis` and
 * `.sidebar-shell`'s `width`). Both now read one custom property, and this file
 * owns the three decisions that property needs: what it defaults to, what range
 * a drag may land in, and how a stored string becomes a number again.
 *
 * Pure and DOM-free like the rest of `model/`, and stored the way
 * `model/theme.ts` stores the theme preference — the width is a local view
 * preference, not project state, so it never rides the wire.
 */

export const SIDEBAR_WIDTH_STORAGE_KEY = 'hanekawa.sidebarWidth'

/**
 * The resting width, and the value the stylesheet falls back to when nothing has
 * been stored. Pinned against `styles.css` by `rendererStyleTokens.test.ts`.
 */
export const SIDEBAR_WIDTH_DEFAULT = 280
/**
 * The narrow end. Below this the session rows stop being able to show a title
 * *and* its badge, so the rail would be draggable into uselessness.
 */
export const SIDEBAR_WIDTH_MIN = 220
/** The wide end: past this the canvas, not the sidebar, is the narrow column. */
export const SIDEBAR_WIDTH_MAX = 480

/** The CSS custom property both rules read. Spelled once, imported by `app.ts`. */
export const SIDEBAR_WIDTH_VARIABLE = '--sidebar-width'

export function clampSidebarWidth(px: number): number {
  // A non-finite width is not clamped to an edge — `NaN` means the caller has no
  // width at all, and the default is the honest answer.
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)))
}

/**
 * A stored width, or the default.
 *
 * Takes the raw `localStorage` string — including `null` for "nothing stored" —
 * so the one place that can produce a bad value is also the one place that
 * validates it. A value written by an older build outside today's range is
 * clamped rather than discarded.
 */
export function parseSidebarWidth(raw: string | null): number {
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT
  return clampSidebarWidth(Number.parseFloat(raw))
}

/** The property's value, as CSS. Keeps the `px` suffix out of `app.ts`. */
export function sidebarWidthVariable(px: number): string {
  return `${clampSidebarWidth(px)}px`
}
