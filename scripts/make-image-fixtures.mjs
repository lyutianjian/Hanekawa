#!/usr/bin/env node
/**
 * Regenerates the small real-image fixtures under test/fixtures/images/.
 *
 * S01 of MULTIMODAL_INPUT_IMPLEMENTATION.md commits a handful of tiny real
 * files so later sessions (S04 decode/normalization, S05 storage, S10 Read
 * splitting) can test against actual encoded bytes instead of mocks:
 * transparent PNG, EXIF-oriented JPEG, static WebP, single-frame GIF,
 * multi-frame GIF, a PNG whose file name lies about its format, and a
 * corrupted file. Everything stays a few KB; over-limit inputs are never
 * committed — tests that need them synthesize their own bytes.
 *
 * Most fixtures come straight out of `sharp`, which is the dependency this
 * generator exists to exercise. The animated GIF is the one exception:
 * sharp only writes animation when the *input* already has pages, and raw
 * pixel input cannot carry them, so the frames are packed by the tiny
 * LZW encoder below. It stays willfully simple — one clear code between
 * every literal means the decoder never grows its dictionary and the code
 * width stays a constant 9 bits, so there is no width-change bookkeeping
 * to get wrong.
 *
 * Usage: node scripts/make-image-fixtures.mjs   (rerun after editing)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'test', 'fixtures', 'images')

const SIZE = 64
/**
 * The EXIF fixture's height, deliberately not `SIZE`. A square image makes
 * orientation unobservable: the usual "did we auto-rotate" assertion compares
 * width against height, and on a 64×64 image it reads the same whether the
 * decode path applied the tag or ignored it. At 64×48 a missing `.rotate()`
 * shows up immediately as 64×48 where 48×64 was expected.
 */
const EXIF_HEIGHT = 48

/** Paint an RGBA canvas through a per-pixel callback into a raw buffer. */
function rawRgba(width, height, paint) {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y)
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = a
    }
  }
  return data
}

/** Encode indexed frames as an animated GIF89a with a 256-entry palette. */
function animatedGif({ width, height, frames }) {
  const palette = []
  const paletteIndex = new Map()
  const indexOf = (color) => {
    const key = color.join(',')
    let index = paletteIndex.get(key)
    if (index === undefined) {
      index = palette.length
      paletteIndex.set(key, index)
      palette.push(color)
    }
    return index
  }
  const indexedFrames = frames.map((frame) => frame.map(indexOf))
  if (palette.length > 256) {
    throw new Error('fixture palette exceeds 256 colors')
  }

  const out = []
  const u16 = (value) => [value & 0xff, (value >> 8) & 0xff]
  const push = (...bytes) => out.push(...bytes)

  // Header + logical screen descriptor announcing the 256-entry global table.
  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
  push(...u16(width), ...u16(height), 0xf7, 0x00, 0x00)
  for (let i = 0; i < 256; i += 1) push(...(palette[i] ?? [0, 0, 0]))

  for (const pixels of indexedFrames) {
    // Graphic control extension: 20 cs delay, disposal "do not dispose".
    push(0x21, 0xf9, 0x04, 0x04, 20, 0x00, 0x00, 0x00)
    // Image descriptor over the full logical screen, no local table.
    push(0x2c, ...u16(0), ...u16(0), ...u16(width), ...u16(height), 0x00)
    push(0x08) // LZW minimum code size: 8 → 9-bit clear/eoi codes.

    const CLEAR = 256
    const EOI = 257
    const bytes = []
    let bits = 0
    let bitCount = 0
    const emit = (code) => {
      bits |= code << bitCount
      bitCount += 9
      while (bitCount >= 8) {
        bytes.push(bits & 0xff)
        bits >>= 8
        bitCount -= 8
      }
    }
    emit(CLEAR)
    for (const pixel of pixels) {
      emit(pixel)
      emit(CLEAR) // Keep the decoder dictionary empty; width stays 9 bits.
    }
    emit(EOI)
    if (bitCount > 0) bytes.push(bits & 0xff)

    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255)
      push(chunk.length, ...chunk)
    }
    push(0x00) // End of image data.
  }
  push(0x3b) // Trailer.
  return Buffer.from(out)
}

await mkdir(outDir, { recursive: true })
const written = []

async function writeFixture(name, buffer) {
  await writeFile(path.join(outDir, name), buffer)
  written.push(`${name} (${buffer.length} B)`)
}

// Transparent PNG: opaque blue on the left, fully transparent on the right.
const transparentPng = await sharp(
  rawRgba(SIZE, SIZE, (x, y) => [40 + x, 90, 200, x < SIZE / 2 ? 255 : 0]),
  { raw: { width: SIZE, height: SIZE, channels: 4 } },
)
  .png({ compressionLevel: 9 })
  .toBuffer()
await writeFixture('transparent.png', transparentPng)

// JPEG carrying an EXIF orientation tag (rotate 90 CW) that decoders must apply.
// Non-square on purpose — see EXIF_HEIGHT.
const exifJpeg = await sharp(
  rawRgba(SIZE, EXIF_HEIGHT, (x, y) => [230 - x * 3, 140 + y, 60, 255]),
  { raw: { width: SIZE, height: EXIF_HEIGHT, channels: 4 } },
)
  .jpeg({ quality: 90 })
  .withMetadata({ orientation: 6 })
  .toBuffer()
await writeFixture('exif-orientation.jpg', exifJpeg)

// Static WebP.
const staticWebp = await sharp(
  rawRgba(SIZE, SIZE, (x, y) => [30, 160, 30 + x * 3, 255]),
  { raw: { width: SIZE, height: SIZE, channels: 4 } },
)
  .webp({ quality: 90 })
  .toBuffer()
await writeFixture('static.webp', staticWebp)

// Single-frame GIF.
const singleFrameGif = await sharp(
  rawRgba(SIZE, SIZE, (x, y) => [200, 60, 60 + x, 255]),
  { raw: { width: SIZE, height: SIZE, channels: 4 } },
)
  .gif()
  .toBuffer()
await writeFixture('single-frame.gif', singleFrameGif)

// Multi-frame GIF: three solid-ish 16x16 frames, hand-packed (see header).
const frame = (r, g, b) =>
  Array.from({ length: 16 * 16 }, (_, index) => {
    const x = index % 16
    const y = Math.floor(index / 16)
    return [r + ((x + y) % 8), g, b]
  })
const animatedGifBytes = animatedGif({
  width: 16,
  height: 16,
  frames: [frame(40, 100, 200), frame(180, 60, 60), frame(60, 180, 90)],
})
await writeFixture('animated.gif', animatedGifBytes)

// Fake extension: real PNG bytes, lying `.jpg` file name. Different color from
// transparent.png so tests can tell them apart after content-sniffing.
const fakeExtPng = await sharp(
  rawRgba(SIZE, SIZE, (x, y) => [x * 3, 220 - y * 2, 40, 255]),
  { raw: { width: SIZE, height: SIZE, channels: 4 } },
)
  .png({ compressionLevel: 9 })
  .toBuffer()
await writeFixture('png-named-jpg.jpg', fakeExtPng)

// Corrupted file: a PNG signature followed by garbage. Must fail to decode.
const corruptBytes = Buffer.concat([
  transparentPng.subarray(0, 8),
  Buffer.alloc(512, 0xff),
])
await writeFixture('corrupt.png', corruptBytes)

console.log(`wrote ${written.length} fixtures to ${outDir}:`)
for (const line of written) console.log(`  ${line}`)

// Self-check: every fixture must decode to the shape this file intended.
const checks = [
  ['transparent.png', { format: 'png', width: SIZE, height: SIZE, hasAlpha: true }],
  ['exif-orientation.jpg', { format: 'jpeg', width: SIZE, height: EXIF_HEIGHT, orientation: 6 }],
  ['static.webp', { format: 'webp', width: SIZE, height: SIZE }],
  ['single-frame.gif', { format: 'gif', width: SIZE, height: SIZE }],
  ['animated.gif', { format: 'gif', width: 16, height: 16, pages: 3 }],
  ['png-named-jpg.jpg', { format: 'png', width: SIZE, height: SIZE }],
]
for (const [name, expected] of checks) {
  const meta = await sharp(path.join(outDir, name)).metadata()
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) {
      throw new Error(`${name}: expected ${key}=${value}, got ${meta[key]}`)
    }
  }
}
try {
  await sharp(path.join(outDir, 'corrupt.png')).metadata()
  throw new Error('corrupt.png unexpectedly decoded')
} catch (error) {
  if (error.message === 'corrupt.png unexpectedly decoded') throw error
}
// The EXIF fixture is only useful if applying the tag changes the dimensions.
{
  const rotated = await sharp(path.join(outDir, 'exif-orientation.jpg')).rotate().toBuffer()
  const meta = await sharp(rotated).metadata()
  if (meta.width !== EXIF_HEIGHT || meta.height !== SIZE) {
    throw new Error(
      `exif-orientation.jpg: rotate() gave ${meta.width}x${meta.height}, ` +
        `expected ${EXIF_HEIGHT}x${SIZE} — orientation is not observable`,
    )
  }
}
console.log('self-check passed: all fixtures decode to their intended shape')
