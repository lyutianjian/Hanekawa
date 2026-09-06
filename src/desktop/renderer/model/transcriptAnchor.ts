/**
 * Where a new turn sits: the arithmetic behind the transcript's bottom pad.
 *
 * Sending a message used to squeeze the turn into whatever height was left under
 * the previous one — `.transcript-column`'s `margin-top: auto` pins a short
 * conversation against the composer, so the bubble appeared at the bottom of the
 * canvas and the answer had a few lines to grow into. The turn in flight is the
 * thing the reader is actually looking at, so it should own the screen: the new
 * bubble rises to the top of the viewport and the answer streams down the empty
 * canvas below it.
 *
 * A scroller cannot scroll past its content, so lifting the last bubble to the
 * top means putting something under it. That something is the reading column's
 * bottom padding — a written number rather than a spacer element, because a new
 * last child would be a scroll-anchor candidate and the sheet's
 * `overflow-anchor` invariant forbids switching that off to compensate. It
 * travels as a custom property, the same door `--context-ratio` uses: the
 * declaration and its fallback stay in the stylesheet, and only the number no
 * stylesheet can compute comes from here.
 *
 * This file owns the number and nothing else. Pure and DOM-free like the rest of
 * `model/`; `dom/transcriptView.ts` does the measuring and the writing.
 */

/**
 * The gap above the anchor when it is the session's first message. There is
 * nothing above it to reveal, so this is the scroller's own top padding and
 * nothing else: the first message is *already* laid out that far down, and
 * scrolling it any higher would mean sending it visibly nudged the bubble up by
 * a few pixels for no reason the reader could name.
 */
export const ANCHOR_TOP_FIRST_PX = 8
/**
 * …and the gap when something precedes it. A line or two of the previous answer
 * stays visible, which is what makes the jump read as a scroll rather than as
 * the conversation having been wiped.
 */
export const ANCHOR_TOP_PX = 64
/**
 * The pad never falls below this, however long the answer runs. Two things come
 * out of the floor: the last line of a full-screen answer keeps its distance
 * from the composer, and the pad does not snap to zero when the turn ends —
 * there is no frame in which the transcript jumps because the model stopped
 * talking.
 */
export const ANCHOR_FLOOR_PX = 96

/** The custom property `.transcript-column`'s `padding-bottom` reads. */
export const TRANSCRIPT_PAD_VARIABLE = '--transcript-pad'

export interface AnchorMetrics {
  /** The scroller's `clientHeight`. */
  readonly viewport: number
  /**
   * From the anchor's top edge to the end of the scrollable area, in px — the
   * scroller's own trailing padding included, and the pad already written
   * excluded.
   */
  readonly below: number
  /** `ANCHOR_TOP_FIRST_PX` or `ANCHOR_TOP_PX`. */
  readonly topGap: number
}

/**
 * The reading column's `padding-bottom`.
 *
 * The anchor sits `topGap` below the scroller's top once the scroller is at its
 * end, which is to say when `maxScrollTop === anchorTop - topGap`. A scroller's
 * `maxScrollTop` is `contentHeight + pad - viewport`, and `below` is
 * `contentHeight - anchorTop`, so the two together give
 * `pad = viewport - topGap - below` — no `anchorTop` in the answer, which is why
 * the caller never has to measure one.
 *
 * That value shrinks by exactly as much as the answer grows, which is what keeps
 * the bubble still while a turn streams: the scroller is at its end after the
 * anchored scroll, so every later frame follows the tail into a pad that is
 * getting shorter at the same rate. The floor is where the two part company, and
 * from there the answer scrolls the bubble off the top like any other content.
 */
export function anchorPadding(metrics: AnchorMetrics): number {
  const { viewport, below, topGap } = metrics
  // A measurement that is not a number means the caller has no layout to reason
  // about — mid-animation, or a pane that has never been on screen. The floor is
  // the honest answer there: it is the one part of the pad that does not depend
  // on where anything is.
  if (!Number.isFinite(viewport) || !Number.isFinite(below) || !Number.isFinite(topGap)) {
    return ANCHOR_FLOOR_PX
  }
  return Math.max(ANCHOR_FLOOR_PX, Math.round(viewport - topGap - below))
}

/**
 * The gap to leave above the anchor. `first` is whether the anchor is the very
 * first thing in the transcript — spelled here rather than at the call site so
 * the two constants are only ever read together.
 */
export function anchorTopGap(first: boolean): number {
  return first ? ANCHOR_TOP_FIRST_PX : ANCHOR_TOP_PX
}
