import type { SessionRecord } from './types.js'

const DEFAULT_MAX_MEDIA_ITEMS = 100

/**
 * Strips excess media items (images, PDFs) from session records once content
 * becomes structured blocks. Currently a no-op since ChatMessage.content is a
 * plain string. When content is extended to support structured blocks, this
 * function will enforce the media item cap without architectural changes.
 */
export function stripExcessMediaItems(
  records: SessionRecord[],
  maxMediaItems: number = DEFAULT_MAX_MEDIA_ITEMS,
): SessionRecord[] {
  void maxMediaItems
  return records
}
