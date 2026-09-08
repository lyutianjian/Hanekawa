import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageAttachmentRef } from '../src/media/types.js'
import {
  keepsDraftAttachments,
  draftImageRefs,
  formatDraftAttachmentLine,
  formatImageAttachmentSummary,
  removeDraftImageAt,
  type DraftImage,
} from '../src/tui/utils/imageDrafts.js'

function makeRef(id: string, name: string, width = 1920, height = 1080): ImageAttachmentRef {
  return { id, ownerSessionId: 'session-1', name, mimeType: 'image/png', width, height, byteLength: 1000 }
}

function makeDraft(id: string, name: string, animated = false): DraftImage {
  return { ref: makeRef(id, name), ...(animated ? { animated: true } : {}) }
}

test('slash commands keep the draft attachments; plain messages take them along', () => {
  // The control commands the design names must not consume the drafts.
  assert.equal(keepsDraftAttachments('/model'), true)
  assert.equal(keepsDraftAttachments('/model sonnet'), true)
  assert.equal(keepsDraftAttachments('/provider'), true)
  assert.equal(keepsDraftAttachments('/effort high'), true)
  assert.equal(keepsDraftAttachments('/e high'), true)
  assert.equal(keepsDraftAttachments('/paste-image'), true)
  assert.equal(keepsDraftAttachments('/attachments remove 1'), true)
  // View-only and unknown commands keep them too: only a real message carries
  // the drafts out of the composer.
  assert.equal(keepsDraftAttachments('/cost'), true)
  assert.equal(keepsDraftAttachments('/unknown-thing'), true)
  assert.equal(keepsDraftAttachments('what is in this image?'), false)
  assert.equal(keepsDraftAttachments(''), false)
  assert.equal(keepsDraftAttachments('  /not-a-command, just text'), false)
})

test('draftImageRefs preserves order and collapses an empty draft to undefined', () => {
  assert.equal(draftImageRefs([]), undefined)
  const a = makeDraft('img-a', 'a.png')
  const b = makeDraft('img-b', 'b.png')
  assert.deepEqual(draftImageRefs([a, b]), [a.ref, b.ref])
})

test('attachment lines use the numbered design format', () => {
  assert.equal(
    formatDraftAttachmentLine(1, makeDraft('img-1', 'screenshot.png')),
    '[图片 1：screenshot.png，1920×1080]',
  )
  assert.equal(
    formatDraftAttachmentLine(3, makeDraft('img-3', 'anim.gif', true)),
    '[图片 3：anim.gif，1920×1080，动画首帧]',
  )
  // Restored drafts lack the animated annotation; the line stays valid.
  assert.equal(
    formatImageAttachmentSummary(2, makeRef('img-2', 'anim.gif', 800, 600)),
    '图片 2：anim.gif，800×600',
  )
})

test('removing by number renumbers the surviving list automatically', () => {
  const drafts = [makeDraft('img-1', 'a.png'), makeDraft('img-2', 'b.png'), makeDraft('img-3', 'c.png')]

  const removed = removeDraftImageAt(drafts, 2)
  assert.equal(removed.ok, true)
  assert.deepEqual(
    removed.next.map((draft) => draft.ref.id),
    ['img-1', 'img-3'],
  )
  // Numbering is list position, so the survivor once known as 3 now renders as 2.
  assert.equal(formatDraftAttachmentLine(2, removed.next[1]!), '[图片 2：c.png，1920×1080]')

  assert.deepEqual(removeDraftImageAt(drafts, 0), { ok: false, message: 'No image 0; the draft has 3.', next: drafts })
  assert.deepEqual(removeDraftImageAt(drafts, 4), { ok: false, message: 'No image 4; the draft has 3.', next: drafts })
  const empty = removeDraftImageAt([], 1)
  assert.equal(empty.ok, false)
  assert.match(empty.message!, /no draft images/)
})
