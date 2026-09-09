import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCurrentImagesAvailable,
  assertNewImagesAllowed,
  formatHistoricalImagePlaceholder,
  formatHistoricalProjectionNotice,
  formatMissingHistoricalImagePlaceholder,
  formatNewImagesBlockedMessage,
  formatSummaryImagePlaceholder,
  projectRecordImagesToText,
  projectTurnImagesForRequest,
  resolveAttachmentFactsForRecords,
  TurnImageBlockError,
  type AttachmentFactsResolver,
} from '../src/harness/turnImages.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import type { SessionRecord } from '../src/harness/types.js'

function userMessageWithImages(id: string, turnId: string | undefined, content: string, images: ImageAttachmentRef[]): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'user',
    content,
    createdAt: '2026-09-08T00:00:00.000Z',
    ...(turnId !== undefined ? { turnId } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
}

function toolResultWithImages(id: string, turnId: string, images: ImageAttachmentRef[]): SessionRecord {
  return {
    type: 'tool_result',
    id,
    toolUseId: `${id}-call`,
    tool: 'Read',
    ok: true,
    content: 'image read',
    createdAt: '2026-09-08T00:00:01.000Z',
    turnId,
    ...(images.length > 0 ? { images } : {}),
  }
}

const factsResolver = (missing: string[] = []): AttachmentFactsResolver => ({
  resolveAttachmentFacts: async (ref) => {
    if (missing.includes(ref.id)) return { ok: false }
    return {
      ok: true,
      facts: {
        originalWidth: 64,
        originalHeight: 48,
        exifOrientation: 6,
        localPath: `/cache/${ref.id}/original.png`,
      },
    }
  },
})

test('assertNewImagesAllowed allows text-only inputs and capable models, and treats absent capability as not capable', () => {
  const ref = makeImageAttachmentRef()
  assertNewImagesAllowed(undefined, false, 'm')
  assertNewImagesAllowed([], false, 'm')
  assertNewImagesAllowed([ref], true, 'm')
  assert.throws(() => assertNewImagesAllowed([ref], undefined, 'm'))
})

test('assertNewImagesAllowed blocks new images for a text-only model with a structured reason', () => {
  const first = makeImageAttachmentRef({ id: 'img-a', name: 'a.png' })
  const second = makeImageAttachmentRef({ id: 'img-b', name: 'b.png' })
  assert.throws(
    () => assertNewImagesAllowed([first, second], false, 'text-only-model'),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.equal(error.imageInputBlock, 'model-not-capable')
      assert.deepEqual(error.images, [first, second])
      assert.equal(
        error.message,
        formatNewImagesBlockedMessage(2, 'text-only-model'),
      )
      assert.match(error.message, /text-only-model does not accept image input/)
      assert.match(error.message, /carries 2 images/)
      return true
    },
  )
})

test('assertCurrentImagesAvailable blocks when the store says a current image is gone', async () => {
  const kept = makeImageAttachmentRef({ id: 'img-kept' })
  const gone = makeImageAttachmentRef({ id: 'img-gone', name: 'gone.png' })
  await assertCurrentImagesAvailable([kept], factsResolver(['img-gone']))
  await assert.rejects(
    assertCurrentImagesAvailable([kept, gone], factsResolver(['img-gone'])),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.equal(error.imageInputBlock, 'file-missing')
      assert.deepEqual(error.images, [gone])
      assert.match(error.message, /gone\.png/)
      return true
    },
  )
})

test('assertCurrentImagesAvailable is a no-op without a resolver', async () => {
  const ref = makeImageAttachmentRef()
  await assertCurrentImagesAvailable([ref], undefined)
})

test('a capable model passes records through untouched', async () => {
  const historical = makeImageAttachmentRef({ id: 'img-old' })
  const current = makeImageAttachmentRef({ id: 'img-new' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'earlier', [historical]),
    userMessageWithImages('new-user', 'turn-new', 'now', [current]),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: true,
  })

  assert.equal(projection.records, records)
  assert.equal(projection.projectedImageCount, 0)
  assert.equal(projection.newImageCount, 1)
})

test('classification is by turn and message id, never by array position', async () => {
  const current = makeImageAttachmentRef({ id: 'img-cur' })
  const historical = makeImageAttachmentRef({ id: 'img-hist' })
  // The current-turn message sits in the middle; the historical one is last.
  const records: SessionRecord[] = [
    userMessageWithImages('mid-user', 'turn-cur', 'current turn', [current]),
    userMessageWithImages('old-user', 'turn-old', 'earlier', [historical]),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-cur',
    currentUserMessageId: 'mid-user',
    supportsImageInput: true,
  })

  assert.equal(projection.newImageCount, 1)
  assert.equal(projection.historicalImageCount, 1)
  assert.equal(projection.projectedImageCount, 0)
})

test('a text-only model with new images never degrades them — the projection throws', async () => {
  const current = makeImageAttachmentRef({ id: 'img-cur' })
  const historical = makeImageAttachmentRef({ id: 'img-hist' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'earlier', [historical]),
    userMessageWithImages('new-user', 'turn-new', 'now', [current]),
  ]

  await assert.rejects(
    projectTurnImagesForRequest({
      records,
      currentTurnId: 'turn-new',
      currentUserMessageId: 'new-user',
      supportsImageInput: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.equal(error.imageInputBlock, 'model-not-capable')
      assert.deepEqual(error.images, [current])
      return true
    },
  )
})

test('current-turn tool results count as new images; earlier-turn tool results are history', async () => {
  const currentToolImage = makeImageAttachmentRef({ id: 'img-tool-cur' })
  const historicalToolImage = makeImageAttachmentRef({ id: 'img-tool-old' })
  const records: SessionRecord[] = [
    toolResultWithImages('old-read', 'turn-old', [historicalToolImage]),
    userMessageWithImages('new-user', 'turn-new', 'now', []),
    toolResultWithImages('new-read', 'turn-new', [currentToolImage]),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: true,
  })
  assert.equal(projection.newImageCount, 1)
  assert.equal(projection.historicalImageCount, 1)
  assert.equal(projection.projectedImageCount, 0)

  // Same shape, text-only model, no current-turn images at all: the earlier
  // turn's tool image degrades.
  const onlyHistory: SessionRecord[] = [
    toolResultWithImages('old-read', 'turn-old', [historicalToolImage]),
    userMessageWithImages('new-user', 'turn-new', 'now', []),
  ]
  const degraded = await projectTurnImagesForRequest({
    records: onlyHistory,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(),
  })
  assert.equal(degraded.projectedImageCount, 1)
  const projectedTool = degraded.records.find((record) => record.id === 'old-read')
  assert.equal(projectedTool?.type, 'tool_result')
  assert.equal('images' in (projectedTool ?? {}), false)
  assert.match(projectedTool?.type === 'tool_result' ? projectedTool.content : '', /Historical image omitted/)
})

test('legacy records without a turn id are history, and a message id match is current', async () => {
  const legacy = makeImageAttachmentRef({ id: 'img-legacy' })
  const restored = makeImageAttachmentRef({ id: 'img-restored' })
  const records: SessionRecord[] = [
    // Old-session record: no turnId at all.
    userMessageWithImages('legacy-user', undefined, 'from an old session', [legacy]),
    // Restored draft whose record lost its turnId but keeps the message id.
    userMessageWithImages('restore-user', undefined, 'restored draft', [restored]),
  ]

  // Classification first, on a capable model: the id match rescues the
  // restored draft as current even without a turnId; the legacy record — with
  // neither id nor turn match — is history.
  const capable = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'restore-user',
    supportsImageInput: true,
  })
  assert.equal(capable.newImageCount, 1)
  assert.equal(capable.historicalImageCount, 1)

  // On a text-only model, a *new* image present (the restored draft) blocks
  // instead of degrading — the same submission rule, rechecked at request time.
  await assert.rejects(
    projectTurnImagesForRequest({
      records,
      currentTurnId: 'turn-new',
      currentUserMessageId: 'restore-user',
      supportsImageInput: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.deepEqual(error.images, [restored])
      return true
    },
  )

  // Without the id match, the restored-looking record is just history and
  // degrades like the legacy one.
  const degraded = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(),
  })
  assert.equal(degraded.projectedImageCount, 2)
  assert.equal(degraded.newImageCount, 0)
  const legacyRecord = degraded.records.find((record) => record.id === 'legacy-user')
  assert.match(legacyRecord?.type === 'message' ? legacyRecord.content : '', /Historical image omitted/)
})

test('the historical placeholder follows the design template with oriented original dimensions', async () => {
  const ref = makeImageAttachmentRef({ id: 'img-1', name: 'screenshot.png' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'what is this', [ref]),
    userMessageWithImages('new-user', 'turn-new', 'summarize', []),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(),
  })

  const oldUser = projection.records.find((record) => record.id === 'old-user')
  assert.equal(oldUser?.type, 'message')
  if (oldUser?.type !== 'message') return
  // Orientation 6 swaps the stored 64x48, so the oriented original is 48x64.
  assert.equal(
    oldUser.content,
    'what is this\n\n[Historical image omitted for this text-only model:\n'
      + 'screenshot.png, original 48x64, cached at /cache/img-1/original.png.\n'
      + 'The pixels are not present in this request.]',
  )
  assert.equal('images' in oldUser, false)
  assert.equal(projection.projectedImageCount, 1)
  assert.equal(projection.missingImageCount, 0)
})

test('a missing historical file keeps its slot with an explicit file-missing placeholder', async () => {
  const ref = makeImageAttachmentRef({ id: 'img-gone', name: 'gone.png' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'what is this', [ref]),
    userMessageWithImages('new-user', 'turn-new', 'summarize', []),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(['img-gone']),
  })

  const oldUser = projection.records.find((record) => record.id === 'old-user')
  assert.equal(oldUser?.type, 'message')
  assert.equal(
    oldUser?.type === 'message' ? oldUser.content : undefined,
    'what is this\n\n' + formatMissingHistoricalImagePlaceholder(ref),
  )
  assert.equal(projection.projectedImageCount, 1)
  assert.equal(projection.missingImageCount, 1)
  assert.match(formatHistoricalProjectionNotice(1, 1), /could not be found on disk/)
})

test('without a resolver, unresolved history uses the file-missing placeholder', async () => {
  const ref = makeImageAttachmentRef({ id: 'img-any' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', '', [ref]),
    userMessageWithImages('new-user', 'turn-new', 'summarize', []),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
  })

  const oldUser = projection.records.find((record) => record.id === 'old-user')
  // A pure-image historical message keeps its slot as exactly the placeholder.
  assert.equal(
    oldUser?.type === 'message' ? oldUser.content : undefined,
    formatMissingHistoricalImagePlaceholder(ref),
  )
  assert.equal(projection.missingImageCount, 1)
})

test('multiple images on one record project in order, joined as separate blocks', async () => {
  const first = makeImageAttachmentRef({ id: 'img-1', name: 'one.png' })
  const second = makeImageAttachmentRef({ id: 'img-2', name: 'two.png' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'two shots', [first, second]),
    userMessageWithImages('new-user', 'turn-new', 'summarize', []),
  ]

  const projection = await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(['img-2']),
  })

  const oldUser = projection.records.find((record) => record.id === 'old-user')
  assert.equal(
    oldUser?.type === 'message' ? oldUser.content : undefined,
    'two shots\n\n'
      + formatHistoricalImagePlaceholder(first, {
        originalWidth: 64,
        originalHeight: 48,
        exifOrientation: 6,
        localPath: '/cache/img-1/original.png',
      })
      + '\n\n'
      + formatMissingHistoricalImagePlaceholder(second),
  )
  assert.equal(projection.projectedImageCount, 2)
  assert.equal(projection.missingImageCount, 1)
})

test('projection never mutates the input records', async () => {
  const ref = makeImageAttachmentRef({ id: 'img-old' })
  const records: SessionRecord[] = [
    userMessageWithImages('old-user', 'turn-old', 'what is this', [ref]),
    userMessageWithImages('new-user', 'turn-new', 'summarize', []),
  ]
  const snapshot = structuredClone(records)

  await projectTurnImagesForRequest({
    records,
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false,
    resolveAttachmentFacts: factsResolver(),
  })

  assert.deepEqual(records, snapshot)
})

test('the signature is stable per image set and changes with it', async () => {
  const base = {
    currentTurnId: 'turn-new',
    currentUserMessageId: 'new-user',
    supportsImageInput: false as const,
    resolveAttachmentFacts: factsResolver(),
  }
  const first = makeImageAttachmentRef({ id: 'img-1' })
  const second = makeImageAttachmentRef({ id: 'img-2' })

  const once = await projectTurnImagesForRequest({
    ...base,
    records: [
      userMessageWithImages('old-user', 'turn-old', 'a', [first]),
      userMessageWithImages('new-user', 'turn-new', 'now', []),
    ],
  })
  const again = await projectTurnImagesForRequest({
    ...base,
    records: [
      userMessageWithImages('old-user', 'turn-old', 'a', [first]),
      userMessageWithImages('new-user', 'turn-new', 'now', []),
    ],
  })
  const grown = await projectTurnImagesForRequest({
    ...base,
    records: [
      userMessageWithImages('old-user', 'turn-old', 'a', [first, second]),
      userMessageWithImages('new-user', 'turn-new', 'now', []),
    ],
  })

  assert.equal(once.signature, again.signature)
  assert.notEqual(once.signature, grown.signature)

  // Switching back to a capable model changes the signature silently, so a
  // later re-degradation of the same set notifies again.
  const capable = await projectTurnImagesForRequest({
    ...base,
    supportsImageInput: true,
    records: [
      userMessageWithImages('old-user', 'turn-old', 'a', [first]),
      userMessageWithImages('new-user', 'turn-new', 'now', []),
    ],
  })
  assert.notEqual(capable.signature, once.signature)
})

test('the placeholder never claims visual content', () => {
  const ref = makeImageAttachmentRef({ name: 'screenshot.png' })
  const text = formatHistoricalImagePlaceholder(ref, {
    originalWidth: 3840,
    originalHeight: 2160,
    localPath: '/cache/original.png',
  })
  assert.match(text, /The pixels are not present in this request\./)
  assert.doesNotMatch(text, /shows|depicts|contains a|OCR/i)
  assert.match(formatHistoricalProjectionNotice(3, 0), /3 historical images/)
})

test('the summary placeholder names the attachment, its size and its cache location', () => {
  const ref = makeImageAttachmentRef({ id: 'img-x', name: 'screenshot.png', width: 800, height: 600 })
  const withFacts = formatSummaryImagePlaceholder(ref, {
    originalWidth: 3840,
    originalHeight: 2160,
    localPath: '/cache/img-x/original.png',
  })
  assert.match(withFacts, /screenshot\.png, sent 800x600, original 3840x2160, cached at \/cache\/img-x\/original\.png\./)
  // No resolver: the attachment ID stands in for the path, never a guess at one.
  const withoutFacts = formatSummaryImagePlaceholder(ref)
  assert.match(withoutFacts, /screenshot\.png, sent 800x600, cached in this session's attachment store \(attachment img-x\)\./)
  assert.doesNotMatch(withoutFacts, /cached at/)
  for (const text of [withFacts, withoutFacts]) {
    assert.match(text, /do not describe or infer what the image shows/)
  }
})

test('the summary placeholder applies EXIF orientation to the original dimensions', () => {
  const text = formatSummaryImagePlaceholder(makeImageAttachmentRef(), {
    originalWidth: 64,
    originalHeight: 48,
    exifOrientation: 6,
    localPath: '/cache/o.png',
  })
  assert.match(text, /original 48x64/)
})

test('projectRecordImagesToText drops the images and appends one placeholder per ref', () => {
  const record = toolResultWithImages('res-1', 'turn-1', [
    makeImageAttachmentRef({ id: 'img-a', name: 'a.png' }),
    makeImageAttachmentRef({ id: 'img-b', name: 'b.png' }),
  ])
  const projected = projectRecordImagesToText(record)
  assert.equal((projected as { images?: unknown }).images, undefined)
  assert.equal('images' in projected, false)
  assert.ok(projected.type === 'tool_result')
  assert.match(projected.content, /^image read\n\n\[Image attachment omitted[\s\S]*a\.png[\s\S]*\n\n\[Image attachment omitted[\s\S]*b\.png/)
  // A pure projection: the input record keeps its refs for the next request.
  assert.equal((record as { images?: unknown[] }).images?.length, 2)
})

test('projectRecordImagesToText replaces content and still drops images', () => {
  const record = toolResultWithImages('res-1', 'turn-1', [makeImageAttachmentRef({ name: 'a.png' })])
  const projected = projectRecordImagesToText(record, { content: '[cleared]' })
  assert.ok(projected.type === 'tool_result')
  assert.match(projected.content, /^\[cleared\]\n\n\[Image attachment omitted/)
  assert.doesNotMatch(projected.content, /image read/)
  assert.equal('images' in projected, false)
})

test('projectRecordImagesToText leaves image-free records alone unless text is replaced', () => {
  const record = userMessageWithImages('u1', 'turn-1', 'hello', [])
  assert.equal(projectRecordImagesToText(record), record)
  const replaced = projectRecordImagesToText(record, { content: 'cleared' })
  assert.ok(replaced.type === 'message')
  assert.equal(replaced.content, 'cleared')
})

test('resolveAttachmentFactsForRecords maps resolvable refs and skips the rest', async () => {
  const records = [
    userMessageWithImages('u1', 'turn-1', 'look', [makeImageAttachmentRef({ id: 'img-a' })]),
    toolResultWithImages('res-1', 'turn-1', [makeImageAttachmentRef({ id: 'img-gone' })]),
  ]
  assert.equal(await resolveAttachmentFactsForRecords(records, undefined), undefined)
  const facts = await resolveAttachmentFactsForRecords(records, factsResolver(['img-gone']))
  assert.equal(facts?.size, 1)
  assert.equal(facts?.get('img-a')?.localPath, '/cache/img-a/original.png')
  // A store that throws degrades the placeholder, never the summary.
  const throwing = await resolveAttachmentFactsForRecords(records, {
    resolveAttachmentFacts: async () => { throw new Error('store offline') },
  })
  assert.equal(throwing?.size, 0)
})
