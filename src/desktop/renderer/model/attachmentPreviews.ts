/**
 * The state behind a pane's attachment thumbnails (design §6.3, session S12).
 *
 * A thumbnail is a size-capped data URL fetched on demand through
 * `get-attachment-preview`; it is never part of a snapshot, so the host does
 * not re-send it while a turn streams. This module is the bookkeeping that
 * keeps the renderer's half of that promise: one request per image id from the
 * automatic path (the strip paint), an explicit retry only when the user asks
 * for the popover, and a bounded LRU so a long-lived pane cannot accumulate an
 * unbounded pile of data URLs.
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
 * The bound. A draft list is capped at 10 (`MAX_DRAFT_IMAGES`), the transcript
 * rows do not carry thumbnails, and only the *active* pane's strip is painted —
 * so 16 covers a full strip with headroom; the LRU is the safety net for a
 * session restored many times over, not a number anything should hit.
 */
export const MAX_ATTACHMENT_PREVIEWS = 16

/** `started` is false when the automatic path has nothing to do: loading, ready, or already failed. */
export function beginPreviewLoad(
  cache: AttachmentPreviewCache,
  imageId: string,
): { cache: AttachmentPreviewCache; started: boolean } {
  if (cache.has(imageId)) return { cache, started: false }
  return { cache: new Map(cache).set(imageId, { status: 'loading' }), started: true }
}

/**
 * The explicit path: a failed load may be re-run, because a failed thumbnail
 * should not condemn the preview popover forever. Loading and ready are still
 * one request in flight or already answered.
 */
export function retryPreviewLoad(
  cache: AttachmentPreviewCache,
  imageId: string,
): { cache: AttachmentPreviewCache; started: boolean } {
  const entry = cache.get(imageId)
  if (entry !== undefined && entry.status !== 'failed') return { cache, started: false }
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
