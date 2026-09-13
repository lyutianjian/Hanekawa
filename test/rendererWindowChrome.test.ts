import assert from 'node:assert/strict'
import test from 'node:test'
import { titlebarInsets, type TitlebarArea } from '../src/desktop/renderer/model/windowChrome.js'

test('unmeasured chrome reserves the native side on each platform', () => {
  assert.deepEqual(titlebarInsets('darwin', 1080, undefined), { left: 80, right: 0 })
  for (const platform of ['win32', 'linux'] as const) {
    assert.deepEqual(titlebarInsets(platform, 1080, undefined), { left: 0, right: 138 })
  }
})

test('measured chrome follows actual controls rather than assuming their side', () => {
  assert.deepEqual(titlebarInsets('darwin', 1080, {
    visible: true, area: { x: 78, width: 1002, height: 40 },
  }), { left: 78, right: 0 })
  assert.deepEqual(titlebarInsets('win32', 1080, {
    visible: true, area: { x: 0, width: 942, height: 40 },
  }), { left: 0, right: 138 })
  // Linux window managers can place their controls on the left too.
  assert.deepEqual(titlebarInsets('linux', 900, {
    visible: true, area: { x: 90, width: 810, height: 40 },
  }), { left: 90, right: 0 })
})

test('fullscreen releases the reserved area, and leaving it restores native bounds', () => {
  const hidden = { visible: false, area: { x: 0, width: 0, height: 0 } }
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    assert.deepEqual(titlebarInsets(platform, 1920, hidden), { left: 0, right: 0 })
  }
  assert.deepEqual(titlebarInsets('darwin', 900, {
    visible: true, area: { x: 80, width: 820, height: 40 },
  }), { left: 80, right: 0 })
})

test('unusable startup/resize geometry keeps a safe fallback', () => {
  const invalid: TitlebarArea[] = [
    { x: 0, width: 0, height: 0 },
    { x: 80, width: 1000, height: 0 },
    { x: -1, width: 1000, height: 40 },
    { x: 80, width: -10, height: 40 },
    { x: 80, width: 1200, height: 40 },
    { x: 1080, width: 1, height: 40 },
    { x: Number.NaN, width: 1000, height: 40 },
    { x: 80, width: Number.POSITIVE_INFINITY, height: 40 },
  ]
  for (const area of invalid) {
    assert.deepEqual(titlebarInsets('darwin', 1080, { visible: true, area }), { left: 80, right: 0 })
    assert.deepEqual(titlebarInsets('win32', 1080, { visible: true, area }), { left: 0, right: 138 })
  }
})

test('page zoom uses fractional CSS pixels without multiplying by display scale', () => {
  const insets = titlebarInsets('win32', 864, {
    visible: true, area: { x: 0, width: 753.6, height: 32 },
  })
  assert.equal(insets.left, 0)
  assert.ok(Math.abs(insets.right - 110.4) < 1e-9)
  assert.deepEqual(titlebarInsets('darwin', 864, {
    visible: true, area: { x: 62.4, width: 801.6, height: 32 },
  }), { left: 62.4, right: 0 })
  // innerWidth is rounded to an integer, unlike the native overlay rectangle.
  assert.deepEqual(titlebarInsets('darwin', 864, {
    visible: true, area: { x: 62.4, width: 802, height: 32 },
  }), { left: 62.4, right: 0 })
})
