/**
 * A site's icon, as bytes the app's own window is allowed to draw.
 *
 * The renderer runs under `img-src 'self' data:`, so a favicon cannot simply be
 * linked — and relaxing that to `https:` would make the app window itself issue
 * a request to every site the model opens, from the app's session rather than
 * the browsing one. Reading the bytes here keeps the fetch inside the partition
 * that already loaded the page, and hands the panel something it can draw
 * without any network of its own.
 */

import type { Session } from 'electron'

/**
 * An icon larger than this is not an icon. Real favicons are a few kilobytes;
 * the cap is what stops a site handing the wire a megabyte per tab update,
 * since every encoded byte rides the whole tab list on every change.
 */
const MAX_BYTES = 64 * 1024

/** Enough for the tabs a lane realistically holds, several navigations deep. */
const CACHE_LIMIT = 64

/**
 * Icon URL → data URL, `undefined` for one that could not be read.
 *
 * The failures are cached too, deliberately: a site with a 404 favicon fires
 * `page-favicon-updated` on every navigation, and re-fetching a known miss each
 * time is the same request forever.
 */
const cache = new Map<string, string | undefined>()

export async function faviconDataUrl(session: Session, url: string): Promise<string | undefined> {
  if (cache.has(url)) return cache.get(url)
  const encoded = await read(session, url)
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(url, encoded)
  return encoded
}

async function read(session: Session, url: string): Promise<string | undefined> {
  try {
    const response = await session.fetch(url)
    if (!response.ok) return undefined
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!type.startsWith('image/')) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return undefined
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    // A favicon is decoration. Every failure here — offline, refused, malformed
    // — ends the same way: the tab draws its placeholder.
    return undefined
  }
}
