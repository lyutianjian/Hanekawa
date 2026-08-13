import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import {
  getTerminalFocused,
  installTerminalFocusFilter,
} from '../src/tui/clock/terminalFocusState.js'

// The filter is a module singleton (idempotent install), so all cases live in
// one test. It simulates stdin with a PassThrough: the filter attaches first
// and re-emits non-focus bytes via unshift; a second 'readable' listener reads
// the remainder — mirroring how Ink's own stdin listener sits behind it.
test('terminal focus filter strips DECSET 1004 sequences and passes everything else through', async () => {
  const stream = new PassThrough()

  // First listener = the filter (registered before the consumer, as in main()).
  installTerminalFocusFilter(stream as unknown as NodeJS.ReadStream)

  const received: Buffer[] = []
  stream.on('readable', () => {
    let chunk: unknown
    while ((chunk = stream.read()) !== null) {
      received.push(Buffer.from(chunk as Uint8Array))
    }
  })

  const text = (buffers: Buffer[]): string => Buffer.concat(buffers).toString('utf8')

  // 1. Mixed keystrokes and focus sequences; the sequences vanish.
  stream.write('abc')
  stream.write('\x1b[Idef\x1b[Og')
  await tick()
  assert.equal(text(received), 'abcdefg')
  assert.equal(getTerminalFocused(), false) // last sequence was focus-out

  // 2. A focus sequence split across two writes is still recognized.
  stream.write('\x1b[')
  await tick()
  assert.equal(text(received), 'abcdefg') // prefix held back, nothing escapes
  stream.write('I')
  await tick()
  assert.equal(text(received), 'abcdefg')
  assert.equal(getTerminalFocused(), true)

  // 3. A lone ESC is released on the next emission (not consumed forever).
  stream.write('\x1b')
  await tick()
  stream.write('xy')
  await tick()
  assert.equal(text(received), 'abcdefg\x1bxy')

  // 4. Non-focus CSI sequences (e.g. arrows) pass through untouched.
  stream.write('\x1b[A\x1b[B')
  await tick()
  assert.equal(text(received), 'abcdefg\x1bxy\x1b[A\x1b[B')

  // 5. Empty stdout chunk edges — nothing is corrupted.
  stream.write('')
  await tick()
  assert.equal(text(received), 'abcdefg\x1bxy\x1b[A\x1b[B')
})

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}