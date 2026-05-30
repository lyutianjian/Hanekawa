import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CursorParkingController,
  moveFromBottomToTarget,
  moveFromTargetToBottom,
} from '../src/tui/cursorParking.js'

describe('TUI cursor parking', () => {
  it('moves from the rendered bottom to the declared cursor target', () => {
    assert.equal(moveFromBottomToTarget({ x: 3, y: 2 }, 5), '\x1B[3A\x1B[4G')
  })

  it('restores from the declared cursor target back to the rendered bottom', () => {
    assert.equal(moveFromTargetToBottom({ x: 3, y: 2 }, 5), '\x1B[3B\x1B[1G')
  })

  it('restores before the next frame and parks again without showing the cursor', () => {
    const stream = createFakeStdout()
    const controller = new CursorParkingController(stream)

    controller.patch()
    controller.setTarget({ x: 3, y: 2 })
    stream.write('frame1')
    stream.write('frame2')
    controller.unpatch()

    assert.equal(stream.writes[0], 'frame1\x1B[3A\x1B[4G')
    assert.equal(stream.writes[1], '\x1B[3B\x1B[1Gframe2\x1B[3A\x1B[4G')
    assert.equal(stream.writes.some(write => write.includes('\x1B[?25h')), false)
  })

  it('does not re-park when Ink is showing the cursor during teardown', () => {
    const stream = createFakeStdout()
    const controller = new CursorParkingController(stream)

    controller.patch()
    controller.setTarget({ x: 3, y: 2 })
    stream.write('frame1')
    stream.write('\x1B[?25h')
    controller.unpatch()

    assert.equal(stream.writes[1], '\x1B[3B\x1B[1G\x1B[?25h')
  })
})

function createFakeStdout(): NodeJS.WriteStream & { writes: string[] } {
  const writes: string[] = []
  return {
    rows: 5,
    columns: 20,
    isTTY: true,
    writes,
    write(chunk: string | Uint8Array) {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
  } as NodeJS.WriteStream & { writes: string[] }
}
