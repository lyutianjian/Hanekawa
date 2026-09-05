/**
 * The hover marquee: a title too long for its row scrolls itself, once the
 * pointer is on it.
 *
 * The ellipsis says *that* a name was cut; it never says what was cut off, and a
 * session's distinguishing part is usually its tail. The `title` tooltip has the
 * full string but costs a second of waiting and covers the row it describes.
 *
 * The decision is here rather than in the view because it is arithmetic, not
 * DOM: how far to travel and how long that takes. The view measures two numbers
 * and applies the answer; this file is what a test can hold.
 *
 * **A loop, not a shuttle.** The text runs one way and comes back around, the
 * way a departure board does — a second copy of the name follows `MARQUEE_GAP`
 * behind the first, and the track travels exactly one copy-plus-gap before
 * restarting, so the restart lands on a frame identical to the one before it and
 * is invisible. Scrolling out and back instead would spend half the cycle
 * reading the name backwards, which is not reading.
 *
 * **Constant speed, variable duration.** A fixed duration would crawl a short
 * name and race a long one — the same animation would read as two behaviours.
 * The track moves at `MARQUEE_SPEED` whatever it has to cover, so a longer name
 * simply takes longer to come around. There is deliberately no cap: an even
 * speed is the whole effect, and a name that outlasts a hover is a name the user
 * stopped reading, not a bug.
 */

/**
 * Scroll speed, px/s. Slow: this is text being read while it moves, and the
 * animation is ambient — it starts under a pointer that may only be passing
 * through, so it has to be calm enough to ignore.
 */
export const MARQUEE_SPEED = 40

/**
 * The blank between the tail of one copy and the head of the next. Without it
 * the name's last character abuts its own first character and the loop reads as
 * one run-on string; this is what makes the seam legible as a seam. Pinned
 * against `--marquee-gap` in `styles.css` by `rendererStyleTokens.test.ts`.
 */
export const MARQUEE_GAP = 48

/** Below this the overhang is a rounding artefact and moving it reads as a twitch. */
export const MARQUEE_MIN_SHIFT = 4

/** The two custom properties the row's rule reads. Spelled once. */
export const MARQUEE_SHIFT_VARIABLE = '--marquee-shift'
export const MARQUEE_DURATION_VARIABLE = '--marquee-duration'

export interface MarqueeMotion {
  /** How far the track moves before it repeats, as CSS. Negative: leftwards. */
  shift: string
  /** One full pass, as CSS. */
  duration: string
}

/**
 * The motion for a name of `contentWidth` in a box of `clientWidth`, or
 * `undefined` when it fits and there is nothing to show.
 *
 * `contentWidth` is one copy of the name — the second is `display: none` until
 * the marquee runs, precisely so this measurement stays the width of one.
 *
 * Both numbers come straight off the element, so both can be garbage — zero
 * while the row is in a folded group, fractional at odd zoom levels. A
 * non-finite or non-overflowing pair is not an error; it is a row that does not
 * marquee.
 */
export function marqueeMotion(contentWidth: number, clientWidth: number): MarqueeMotion | undefined {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(clientWidth)) return undefined
  if (contentWidth - clientWidth < MARQUEE_MIN_SHIFT) return undefined
  // One copy plus the gap: at exactly this offset the second copy sits where the
  // first began, so restarting the animation changes nothing on screen.
  const distance = Math.round(contentWidth) + MARQUEE_GAP
  return {
    shift: `-${distance}px`,
    duration: `${Math.round((distance / MARQUEE_SPEED) * 1000)}ms`,
  }
}
