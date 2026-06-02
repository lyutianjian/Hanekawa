import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'

import { render } from '../src/tui/ink.js'
import { InputBox } from '../src/tui/components/InputBox.js'

test('InputBox declares the current-frame cursor column for mixed CJK input', async () => {
  const stdout = createFakeStdout()
  const instance = render(h(InputBox, { text: '你做', cursorPos: 2 }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  instance.rerender(h(InputBox, { text: '你做s', cursorPos: 3 }))
  await instance.waitUntilRenderFlush()
  const firstFrame = stdout.writes.find((write) => write.includes('你做s')) ?? ''

  stdout.writes.length = 0
  instance.rerender(h(InputBox, { text: '你做sh', cursorPos: 4 }))
  await instance.waitUntilRenderFlush()
  const secondFrame = stdout.writes.find((write) => write.includes('你做sh')) ?? ''

  instance.unmount()

  assert.match(firstFrame, /\x1B\[8G/)
  assert.doesNotMatch(firstFrame, /\x1B\[7G/)
  assert.match(secondFrame, /\x1B\[9G/)
  assert.doesNotMatch(secondFrame, /\x1B\[8G/)
})

function createFakeStdout(): NodeJS.WriteStream & { writes: string[] } {
  const writes: string[] = []
  return {
    rows: 10,
    columns: 40,
    isTTY: true,
    writes,
    write(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      if (done) queueMicrotask(() => done())
      return true
    },
    on() {
      return this
    },
    off() {
      return this
    },
  } as unknown as NodeJS.WriteStream & { writes: string[] }
}
