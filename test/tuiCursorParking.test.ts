import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { CursorParkingController } from '../src/tui/cursorParking.js'

describe('TUI cursor parking', () => {
  it('suppresses Ink show-cursor escapes while preserving cursor movement', () => {
    const stream = createFakeStdout()
    const controller = new CursorParkingController(stream)

    controller.patch()
    stream.write('frame\x1B[2A\x1B[4G\x1B[?25h')
    controller.unpatch()

    assert.equal(stream.writes[0], 'frame\x1B[2A\x1B[4G\x1B[?25l')
    assert.equal(stream.writes[0]?.includes('\x1B[?25h'), false)
  })

  it('restores the real cursor when unpatched', () => {
    const stream = createFakeStdout()
    const controller = new CursorParkingController(stream)

    controller.patch()
    controller.unpatch()

    assert.equal(stream.writes.at(-1), '\x1B[?25h')
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
