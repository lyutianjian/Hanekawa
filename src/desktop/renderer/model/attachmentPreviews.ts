/**
 * The state behind a pane's attachment thumbnails (design §6.3, session S12).
 *
 * A thumbnail is a size-capped data URL fetched on demand through
 * `get-attachment-preview`; it is never part of a snapshot, so the host does
 * not re-send it while a turn streams. This module is the bookkeeping that
 * keeps the renderer's half of that promise: one request per image id from the
 * paints that want thumbnails — the composer's tile grid and the transcript's
 * sent images — and a bounded LRU so a long-lived pane cannot accumulate an
 * unbounded pile of data URLs.
 *
 * There is no retry: a failed id stays failed for this pane's lifetime. The
 * explicit re-ask the preview popover needed went with the popover, and the
 * fullscreen viewer that replaced it fetches its own screen-sized copy rather
 * than reusing this cache.
 *
 * Pure state, immutable maps: the pane owns the current value, every
 * transition answers with the next one, and the model stays testable without
 * a DOM or a client.
 */

/** One id's request state. `unrequested` is the absence of an entry. */
export type AttachmentPreviewEntry =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string }
  | { status: 'failed'; message: string }

export type AttachmentPreviewCache = ReadonlyMap<string, AttachmentPreviewEntry>

/**
 * The bound. A draft list is capped at 10 (`MAX_DRAFT_IMAGES`), but the
 * transcript's sent images draw from this same cache now, and a long
 * conversation's image count is bounded by nothing — so the number covers a
 * full strip plus a screenful of history rather than a strip alone. Past it the
 * LRU evicts the oldest, which costs one re-fetch the next time that row
 * scrolls back into view.
 */
export const MAX_ATTACHMENT_PREVIEWS = 48

/** `started` is false when the automatic path has nothing to do: loading, ready, or already failed. */
export function beginPreviewLoad(
  cache: AttachmentPreviewCache,
  imageId: string,
): { cache: AttachmentPreviewCache; started: boolean } {
  if (cache.has(imageId)) return { cache, started: false }
  return { cache: new Map(cache).set(imageId, { status: 'loading' }), started: true }
}

/** Settles a load and moves the id to the LRU's most-recent end, evicting past the bound. */
export function settlePreviewLoad(
  cache: AttachmentPreviewCache,
  imageId: string,
  dataUrl: string,
): AttachmentPreviewCache {
  const next = new Map(cache)
  next.delete(imageId)
  next.set(imageId, { status: 'ready', dataUrl })
  while (next.size > MAX_ATTACHMENT_PREVIEWS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

export function failPreviewLoad(
  cache: AttachmentPreviewCache,
  imageId: string,
  message: string,
): AttachmentPreviewCache {
  return new Map(cache).set(imageId, { status: 'failed', message })
}

/** The data URL a strip row would paint, when it is already in hand. */
export function previewDataUrl(cache: AttachmentPreviewCache, imageId: string): string | undefined {
  const entry = cache.get(imageId)
  return entry !== undefined && entry.status === 'ready' ? entry.dataUrl : undefined
}
