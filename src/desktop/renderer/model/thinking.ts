import type { TranscriptItem } from './transcript.js'

/**
 * The thinking block's two faces, as pure decisions.
 *
 * A block streams **expanded** under a breathing 「正在思考」, and at `turn-end` it
 * collapses to 「已处理 Xm Xs ⌵」 (`design_guidance.md` 三.3). Both faces are the same
 * node — one header whose label and animation follow the item — because the two
 * states are the same thing at different times, and because the alternative reads
 * the wrong signal: `thinking_stop` clears `TranscriptState.isThinking` while the
 * block is still streaming, so a live label driven by that flag stops mid-turn.
 *
 * What the model does **not** own is which blocks the user has opened or closed by
 * hand: that is per-pane view state, held by `paneSession.ts` and combined here.
 */

/** While the block is still arriving. */
export const THINKING_LIVE_LABEL = '正在思考'
/** A sealed block with no elapsed time — an aborted turn never produced one. */
export const THINKING_DONE_FALLBACK = '思考过程'

export function thinkingHeaderLabel(item: TranscriptItem): string {
  if (item.pending === true) return THINKING_LIVE_LABEL
  return item.summary ?? THINKING_DONE_FALLBACK
}

/**
 * `toggled` records **disagreement with the default**, not "is collapsed".
 *
 * The default is「还在流就展开，封存了就折叠」. Storing the user's intent as a flip of
 * that rather than as an absolute means an expansion made mid-turn survives the
 * moment the block seals — which is exactly when an absolute value would be
 * overwritten — and it needs no second field on the item.
 */
export function isThinkingCollapsed(item: TranscriptItem, toggled: ReadonlySet<string>): boolean {
  const collapsedByDefault = item.pending !== true
  return toggled.has(item.id) ? !collapsedByDefault : collapsedByDefault
}

/**
 * Drops toggles for blocks that no longer exist.
 *
 * Required, not tidiness: a `transcript-reset` rebuilds the state with
 * `thinkingCount` back at zero, so the next block reuses `thinking-0` and would
 * inherit the toggle a *different* block left behind.
 */
export function pruneThinkingToggles(
  items: readonly TranscriptItem[],
  toggled: ReadonlySet<string>,
): Set<string> {
  const live = new Set(items.filter((item) => item.kind === 'thinking').map((item) => item.id))
  return new Set([...toggled].filter((id) => live.has(id)))
}
