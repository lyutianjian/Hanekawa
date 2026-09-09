import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countImageTokens,
  DEFAULT_IMAGE_TOKEN_STRATEGY,
  describeImageTokenStrategy,
  estimateImageTokens,
  imageTokenEstimateIsApproximate,
  resolveImageTokenStrategy,
} from '../src/media/imageTokens.js'
import {
  countContextItemTokens,
  countMessageTokens,
  countMessagesTokens,
  countSessionRecordTokens,
  countSessionRecordsTokens,
  countTextTokens,
} from '../src/prompts/budget.js'
import type { ImageAttachmentRef } from '../src/media/types.js'

function ref(overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id: 'img-1',
    ownerSessionId: 's1',
    name: 'shot.png',
    mimeType: 'image/png',
    width: 64,
    height: 64,
    byteLength: 1000,
    ...overrides,
  }
}

// --- vendor formulas (each pinned to its published shape) --------------------

test('anthropic strategy uses the documented (width x height) / 750 approximation', () => {
  // 2000x1125 -> 2,250,000 / 750 = 3000 exactly.
  assert.equal(estimateImageTokens({ width: 2000, height: 1125 }, 'anthropic'), 3000)
  // 100x100 -> 13.33 -> ceil 14.
  assert.equal(estimateImageTokens({ width: 100, height: 100 }, 'anthropic'), 14)
})

test('openai strategy uses the documented high-detail tiling cost', () => {
  // Shortest side 1125 > 768 -> rescale to 1365x768 -> ceil(1365/512) x ceil(768/512)
  // = 3 x 2 tiles -> 85 + 170*6 = 1105.
  assert.equal(estimateImageTokens({ width: 2000, height: 1125 }, 'openai'), 1105)
  // Small image: no rescale -> a single tile -> 255.
  assert.equal(estimateImageTokens({ width: 400, height: 300 }, 'openai'), 255)
  // Huge image: 2048 rescale first (2048x1536), then 768 (1024x768) -> 4 tiles -> 765.
  assert.equal(estimateImageTokens({ width: 4000, height: 3000 }, 'openai'), 765)
})

test('conservative strategy is the larger of the two known formulas', () => {
  assert.equal(
    estimateImageTokens({ width: 2000, height: 1125 }, 'conservative'),
    Math.max(3000, 1105),
  )
  assert.equal(
    estimateImageTokens({ width: 400, height: 300 }, 'conservative'),
    Math.max(14, 255),
  )
})

test('a text-only model sends no image pixels, so its image-token cost is zero', () => {
  assert.equal(estimateImageTokens({ width: 2000, height: 1125 }, 'none'), 0)
  assert.equal(countImageTokens([ref()], 'none'), 0)
})

test('nonsense dimensions cost zero rather than NaN', () => {
  for (const bad of [{ width: 0, height: 100 }, { width: -5, height: 100 }, { width: NaN, height: 100 }]) {
    assert.equal(estimateImageTokens(bad, 'anthropic'), 0)
    assert.equal(estimateImageTokens(bad, 'conservative'), 0)
  }
})

test('countImageTokens sums across refs and is empty-set friendly', () => {
  assert.equal(countImageTokens(undefined, 'anthropic'), 0)
  assert.equal(countImageTokens([], 'anthropic'), 0)
  assert.equal(
    countImageTokens([ref({ id: 'a', width: 1000, height: 750 }), ref({ id: 'b', width: 500, height: 375 })], 'anthropic'),
    estimateImageTokens({ width: 1000, height: 750 }, 'anthropic')
      + estimateImageTokens({ width: 500, height: 375 }, 'anthropic'),
  )
})

// --- strategy resolution and the approximate label ---------------------------

test('resolveImageTokenStrategy maps capability and provider onto a strategy', () => {
  assert.equal(resolveImageTokenStrategy('anthropic', true), 'anthropic')
  assert.equal(resolveImageTokenStrategy('openai', true), 'openai')
  assert.equal(resolveImageTokenStrategy('custom-gateway', true), 'conservative')
  assert.equal(resolveImageTokenStrategy(undefined, true), 'conservative')
  // Capability wins: an image-capable provider serving a text-only model
  // sends no pixels, so no image tokens are budgeted.
  assert.equal(resolveImageTokenStrategy('anthropic', false), 'none')
  assert.equal(resolveImageTokenStrategy('anthropic', undefined), 'none')
})

test('only the conservative strategy is labelled approximate', () => {
  assert.equal(imageTokenEstimateIsApproximate('conservative'), true)
  assert.equal(imageTokenEstimateIsApproximate('anthropic'), false)
  assert.equal(imageTokenEstimateIsApproximate('openai'), false)
  assert.equal(imageTokenEstimateIsApproximate('none'), false)
  assert.equal(describeImageTokenStrategy('conservative'), 'conservative (approximate)')
  assert.equal(describeImageTokenStrategy('anthropic'), 'anthropic')
  assert.equal(DEFAULT_IMAGE_TOKEN_STRATEGY, 'conservative')
})

// --- budget counters (design §11.2 coverage points) --------------------------

test('a message with images costs clearly more than the same message without', () => {
  const text = 'what is in this screenshot'
  const without = { id: 'm1', role: 'user' as const, content: text, createdAt: '2026-09-09T00:00:00.000Z' }
  const withImage = {
    ...without,
    images: [ref({ width: 2000, height: 1125 })],
  }
  const textOnly = countTextTokens(text)
  assert.equal(countMessageTokens(without), textOnly)
  // Default strategy is conservative: the estimate is far above text alone.
  assert.ok(countMessageTokens(withImage) > textOnly + 1000)
  assert.equal(
    countMessageTokens(withImage, 'anthropic'),
    textOnly + 3000,
  )
  // 'none' is the text-only model's honest count: pixels are projected away.
  assert.equal(countMessageTokens(withImage, 'none'), textOnly)
})

test('image cost never depends on the file path or name length', () => {
  const short = ref({ id: 'a', name: 'a.png', width: 2000, height: 1125 })
  const long = ref({
    id: 'b',
    name: `${'very/'.repeat(80)}long/path/with/many/segments/screenshot-of-a-very-important-scene.png`,
    width: 2000,
    height: 1125,
  })
  assert.equal(countMessageTokens(
    { id: 'm1', role: 'user', content: 'x', createdAt: '', images: [short] },
    'anthropic',
  ), countMessageTokens(
    { id: 'm2', role: 'user', content: 'x', createdAt: '', images: [long] },
    'anthropic',
  ))
})

test('context items carry their images into the count', () => {
  const message = {
    kind: 'message' as const,
    message: {
      id: 'm1',
      role: 'user' as const,
      content: 'look',
      createdAt: '2026-09-09T00:00:00.000Z',
      images: [ref({ width: 1000, height: 750 })],
    },
  }
  const toolResult = {
    kind: 'tool_result' as const,
    toolUseId: 'call-1',
    tool: 'Read',
    ok: true,
    content: 'read the image',
    images: [ref({ id: 'img-tool', width: 500, height: 375 })],
  }
  const expectedMessage = countTextTokens('look') + estimateImageTokens({ width: 1000, height: 750 }, 'anthropic')
  const expectedTool = countTextTokens('Read\nread the image') + estimateImageTokens({ width: 500, height: 375 }, 'anthropic')
  assert.equal(countContextItemTokens(message, 'anthropic'), expectedMessage)
  assert.equal(countContextItemTokens(toolResult, 'anthropic'), expectedTool)
  // And without a strategy the conservative default applies (never cheaper).
  assert.ok(countContextItemTokens(toolResult) >= expectedTool)
})

test('a tool_result _tokens cache holds text only; image cost is added live on top', () => {
  const images = [ref({ id: 'img-tool', width: 2000, height: 1125 })]
  const base = {
    type: 'tool_result' as const,
    id: 'result-1',
    toolUseId: 'call-1',
    tool: 'Read',
    ok: true,
    content: 'read the image',
    createdAt: '2026-09-09T00:00:00.000Z',
    images,
  }
  const textTokens = countTextTokens('Read\nread the image')

  // A cache written before images existed (a pure-text cache) must never read
  // as the whole count — the image cost is recomputed on every read.
  const cachedTextOnly = { ...base, _tokens: 7 }
  assert.equal(countSessionRecordTokens(cachedTextOnly, 'anthropic'), 7 + 3000)

  // The cache follows the strategy that is live at read time, so a model
  // switch changes the total without touching the cached record.
  assert.equal(countSessionRecordTokens(cachedTextOnly, 'none'), 7)
  assert.equal(countSessionRecordTokens(cachedTextOnly, 'openai'), 7 + 1105)

  // Without a cache the text is counted, plus images.
  assert.equal(countSessionRecordTokens(base, 'anthropic'), textTokens + 3000)
})

test('message records count their images; the aggregate stays consistent', () => {
  const message = {
    type: 'message' as const,
    id: 'm1',
    role: 'user' as const,
    content: 'hello there',
    createdAt: '2026-09-09T00:00:00.000Z',
    images: [ref({ width: 2000, height: 1125 })],
  }
  const perRecord = countSessionRecordTokens(message, 'anthropic')
  const aggregate = countSessionRecordsTokens([message], 'system prompt', 'anthropic')
  assert.equal(aggregate, countTextTokens('system prompt') + perRecord)

  const totals = countMessagesTokens(
    [{ ...message, id: 'm2' }, { ...message, id: 'm3', images: undefined }],
    'anthropic',
  )
  assert.deepEqual(totals.messages, [perRecord, countTextTokens('hello there')])
  assert.equal(totals.total, perRecord + countTextTokens('hello there'))
})
