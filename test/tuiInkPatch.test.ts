import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCursorSuffix } from '../node_modules/ink/build/cursor-helpers.js'
import logUpdate from '../node_modules/ink/build/log-update.js'

const HIDE_CURSOR = '\x1B[?25l'
const SHOW_CURSOR = '\x1B[?25h'

test('Ink cursor suffix accounts for fullscreen frames without trailing newline', () => {
  const cursor = { x: 2, y: 3 }

  assert.equal(buildCursorSuffix(5, cursor, true), '\x1B[2A\x1B[3G' + SHOW_CURSOR)
  assert.equal(buildCursorSuffix(5, cursor, false), '\x1B[1A\x1B[3G' + SHOW_CURSOR)
})

test('Ink log-update positions cursor correctly for no-trailing-newline sync frames', () => {
  const stream = createFakeStdout()
  const log = logUpdate.create(stream)
  const output = ['a', 'b', 'c', 'd', 'e'].join('\n')

  log.setCursorPosition({ x: 2, y: 3 })
  log.sync(output)

  assert.equal(stream.writes.at(-1), '\x1B[1A\x1B[3G' + SHOW_CURSOR)
})

test('Ink log-update positions cursor correctly for no-trailing-newline render frames', () => {
  const stream = createFakeStdout()
  const log = logUpdate.create(stream)
  const output = ['a', 'b', 'c', 'd', 'e'].join('\n')

  log.setCursorPosition({ x: 2, y: 3 })
  log(output)

  assert.equal(stream.writes.at(0), HIDE_CURSOR)
  assert.equal(stream.writes.at(1), output + '\x1B[1A\x1B[3G' + SHOW_CURSOR)
})

test('Ink cursor-only updates remember whether the previous frame had a trailing newline', () => {
  const stream = createFakeStdout()
  const log = logUpdate.create(stream)
  const output = ['a', 'b', 'c', 'd', 'e'].join('\n')

  log.setCursorPosition({ x: 0, y: 3 })
  log(output)
  stream.writes.length = 0

  log.setCursorPosition({ x: 1, y: 4 })
  log(output)

  assert.equal(stream.writes.at(-1), HIDE_CURSOR + '\x1B[1B\x1B[1G\x1B[2G' + SHOW_CURSOR)
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
