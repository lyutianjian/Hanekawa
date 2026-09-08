import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  assertNoImageBytes,
  createTempAttachmentArea,
  fixtureImagePath,
  loadFixtureBytes,
  makeImageAttachmentRef,
} from './helpers/imageFixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const FIXTURE_NAMES = [
  'transparent.png',
  'exif-orientation.jpg',
  'static.webp',
  'single-frame.gif',
  'animated.gif',
  'png-named-jpg.jpg',
  'corrupt.png',
]

test('committed image fixtures decode to their documented shape', async () => {
  const expectations: Array<{
    name: string
    format: string
    width: number
    height: number
    orientation?: number
    pages?: number
    hasAlpha?: boolean
  }> = [
    { name: 'transparent.png', format: 'png', width: 64, height: 64, hasAlpha: true },
    { name: 'exif-orientation.jpg', format: 'jpeg', width: 64, height: 64, orientation: 6 },
    { name: 'static.webp', format: 'webp', width: 64, height: 64 },
    { name: 'single-frame.gif', format: 'gif', width: 64, height: 64 },
    { name: 'animated.gif', format: 'gif', width: 16, height: 16, pages: 3 },
    { name: 'png-named-jpg.jpg', format: 'png', width: 64, height: 64 },
  ]
  for (const expected of expectations) {
    // No `animated: true` here: with it, sharp reports the dimensions of the
    // vertically-concatenated page buffer (width × pages) rather than one
    // frame, which is not what the fixture documents.
    const meta = await sharp(fixtureImagePath(expected.name)).metadata()
    assert.equal(meta.format, expected.name === 'png-named-jpg.jpg' ? 'png' : expected.format)
    assert.equal(meta.width, expected.width, expected.name)
    assert.equal(meta.height, expected.height, expected.name)
    if (expected.orientation !== undefined) {
      assert.equal(meta.orientation, expected.orientation, expected.name)
    }
    if (expected.pages !== undefined) {
      assert.equal(meta.pages, expected.pages, expected.name)
    }
    if (expected.hasAlpha !== undefined) {
      assert.equal(meta.hasAlpha, expected.hasAlpha, expected.name)
    }
  }
})

test('the fake-extension fixture is sniffed by content, not by file name', async () => {
  // PNG bytes under a .jpg name must decode as PNG — and must differ from the
  // transparent fixture so content-sniffing tests cannot pass by accident.
  const fake = await sharp(fixtureImagePath('png-named-jpg.jpg')).metadata()
  const transparent = await sharp(fixtureImagePath('transparent.png')).metadata()
  assert.equal(fake.format, 'png')
  assert.equal(fake.width, transparent.width)
  assert.notEqual(
    (await loadFixtureBytes('png-named-jpg.jpg')).toString('hex'),
    (await loadFixtureBytes('transparent.png')).toString('hex'),
  )
})

test('the corrupt fixture fails to decode instead of yielding garbage', async () => {
  await assert.rejects(() => sharp(fixtureImagePath('corrupt.png')).metadata())
})

test('committed fixtures stay a few KB each', async () => {
  for (const name of FIXTURE_NAMES) {
    const { size } = await stat(fixtureImagePath(name))
    assert.ok(size > 0 && size <= 8192, `${name}: ${size} B exceeds the fixture budget`)
  }
})

test('makeImageAttachmentRef fills documented defaults and applies overrides', () => {
  const defaults = makeImageAttachmentRef()
  assert.equal(defaults.id, 'img-test-1')
  assert.equal(defaults.mimeType, 'image/png')
  assert.equal(defaults.width, 64)

  const customized = makeImageAttachmentRef({
    id: 'img-2',
    ownerSessionId: 'session-other',
    mimeType: 'image/webp',
    width: 16,
    height: 16,
    byteLength: 164,
  })
  assert.equal(customized.id, 'img-2')
  assert.equal(customized.ownerSessionId, 'session-other')
  assert.equal(customized.name, 'transparent.png') // untouched field keeps default
  assert.deepEqual({ ...customized }, {
    ...makeImageAttachmentRef(),
    id: 'img-2',
    ownerSessionId: 'session-other',
    mimeType: 'image/webp',
    width: 16,
    height: 16,
    byteLength: 164,
  })
})

test('createTempAttachmentArea creates the S05 layout and cleans up', async () => {
  const area = await createTempAttachmentArea('session-abc')
  try {
    assert.ok(path.isAbsolute(area.attachmentsDir))
    assert.equal(
      path.relative(path.join(area.root, 'attachments'), area.attachmentsDir),
      'session-abc',
    )
    const attachments = await stat(area.attachmentsDir)
    assert.ok(attachments.isDirectory())
  } finally {
    await area.cleanup()
  }
  await assert.rejects(() => stat(area.root))
  await area.cleanup() // Idempotent; a second call must not throw.
})

test('assertNoImageBytes accepts redacted payloads and rejects raw image bytes', async () => {
  const bytes = await loadFixtureBytes('transparent.png')
  const base64 = bytes.toString('base64')

  // A payload that only carries metadata (plus `[redacted…]` markers) passes.
  assertNoImageBytes({
    model: 'vision-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe the image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              data: '[redacted: png 64x64 287 B]',
              media_type: 'image/png',
            },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'a blue-to-transparent strip' }] },
    ],
  })

  // Raw bytes in the Anthropic source block shape.
  assert.throws(
    () => assertNoImageBytes({ source: { type: 'base64', data: base64 } }),
    /raw data characters/,
  )
  // Raw bytes in the OpenAI data-URL shape.
  assert.throws(
    () => assertNoImageBytes({ image_url: { url: `data:image/png;base64,${base64}` } }),
    /data URL survived redaction/,
  )
  // Raw bytes smuggled as an unrelated string field.
  assert.throws(
    () => assertNoImageBytes({ note: base64 }),
    /base64 run survived redaction/,
  )
  // Cycles must not hang the walk.
  const cyclic: Record<string, unknown> = { text: 'ok' }
  cyclic['self'] = cyclic
  assertNoImageBytes(cyclic)
})

test('renderer and preload sources never reference sharp', async () => {
  const rendererRoot = path.join(here, '..', 'src', 'desktop', 'renderer')
  const entries = await readdir(rendererRoot, { recursive: true })
  const files = [
    ...entries
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.ts'))
      .map((entry) => path.join(rendererRoot, entry)),
    path.join(here, '..', 'src', 'desktop', 'preload.ts'),
  ]
  assert.ok(files.length > 5, 'expected to find the renderer sources')
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.ok(
      !/'sharp'|"sharp"/.test(source),
      `${path.relative(here, file)} references sharp; image processing belongs to the Node/Electron main side only`,
    )
  }
})
