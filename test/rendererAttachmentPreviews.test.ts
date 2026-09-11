import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginPreviewLoad,
  failPreviewLoad,
  MAX_ATTACHMENT_PREVIEWS,
  previewDataUrl,
  settlePreviewLoad,
  type AttachmentPreviewCache,
} from '../src/desktop/renderer/model/attachmentPreviews.js'

/**
 * The preview cache's own rules (S12): the automatic path may ask once per id,
 * the explicit path may re-ask after a failure, and the cache is bounded —
 * so a long-lived pane cannot accumulate unbounded data URLs.
 */
test('the automatic path asks once per id; a settle ends the asking', () => {
  let cache: AttachmentPreviewCache = new Map()

  const first = beginPreviewLoad(cache, 'img-1')
  assert.equal(first.started, true)
  cache = first.cache
  assert.equal(cache.get('img-1')?.status, 'loading')

  // The repaint that arrives before the settle — a snapshot tick — must not
  // start a second request.
  const again = beginPreviewLoad(cache, 'img-1')
  assert.equal(again.started, false)
  assert.equal(again.cache, cache, 'an untouched cache is the same object')

  cache = settlePreviewLoad(cache, 'img-1', 'data:image/png;base64,AA')
  assert.equal(previewDataUrl(cache, 'img-1'), 'data:image/png;base64,AA')

  const after = beginPreviewLoad(cache, 'img-1')
  assert.equal(after.started, false, 'a settled id is never re-requested')
})

test('a failure is final for this pane, and never re-asked on its own', () => {
  const cache: AttachmentPreviewCache = failPreviewLoad(new Map(), 'img-1', 'file-missing')

  assert.equal(previewDataUrl(cache, 'img-1'), undefined)
  // Every paint runs this, and a failed id must not turn the paint rate into a
  // request rate — a transcript full of expired attachments would do exactly
  // that, once per streamed chunk.
  const auto = beginPreviewLoad(cache, 'img-1')
  assert.equal(auto.started, false, 'a paint does not retry on its own')
  assert.equal(auto.cache, cache)
})

test('the cache is bounded, evicting the least recently settled', () => {
  let cache: AttachmentPreviewCache = new Map()
  for (let index = 0; index < MAX_ATTACHMENT_PREVIEWS; index += 1) {
    cache = settlePreviewLoad(cache, `img-${index}`, `data:image/png;base64,${index}`)
  }
  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)

  // Re-settling an existing id refreshes it rather than growing the map.
  cache = settlePreviewLoad(cache, 'img-0', 'data:image/png;base64,fresh')
  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)
  assert.equal(previewDataUrl(cache, 'img-0'), 'data:image/png;base64,fresh')

  // The next new id evicts the least recently settled — img-1 here.
  cache = settlePreviewLoad(cache, 'img-new', 'data:image/png;base64,new')
  assert.equal(cache.size, MAX_ATTACHMENT_PREVIEWS)
  assert.equal(previewDataUrl(cache, 'img-1'), undefined, 'the oldest settled entry is gone')
  assert.equal(previewDataUrl(cache, 'img-new'), 'data:image/png;base64,new')
  assert.equal(previewDataUrl(cache, 'img-0'), 'data:image/png;base64,fresh', 'the refreshed entry survived')
})
