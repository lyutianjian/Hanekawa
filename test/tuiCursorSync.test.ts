import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h, useState } from 'react'

import { Box, render, Text } from '../src/tui/ink.js'
import { InputBox } from '../src/tui/components/InputBox.js'
import { AlternateScreen } from '../src/tui/components/AlternateScreen.js'

const ENTER_ALT_SCREEN = '\x1B[?1049h'
const EXIT_ALT_SCREEN = '\x1B[?1049l'
const CLEAR_SCREEN = '\x1B[2J'
const CURSOR_HOME = '\x1B[H'

test('InputBox declares cursor position on the first empty-input frame', async () => {
  const stdout = createFakeStdout()
  const instance = render(h(InputBox, { text: '', cursorPos: 0 }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  const output = stdout.writes.join('')

  instance.unmount()

  assert.match(output, /\x1B\[2A\x1B\[3G/)
})

test('InputBox declares cursor position on first frame after remount', async () => {
  const stdout = createFakeStdout()
  const instance = render(h(InputBox, { text: '', cursorPos: 0 }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  instance.rerender(h(Box, null, h(Text, null, 'placeholder')))
  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  instance.rerender(h(InputBox, { text: '', cursorPos: 0 }))
  await instance.waitUntilRenderFlush()
  const output = stdout.writes.join('')

  instance.unmount()

  assert.match(output, /\x1B\[2A\x1B\[3G/)
})

test('prompt view rewrites input and cursor after alternate-screen round trip', async () => {
  const stdout = createFakeStdout()
  let setScreen: ((screen: 'prompt' | 'transcript') => void) | undefined

  function RoundTripApp() {
    const [screen, nextSetScreen] = useState<'prompt' | 'transcript'>('prompt')
    setScreen = nextSetScreen

    if (screen === 'transcript') {
      return h(
        AlternateScreen,
        null,
        h(Box, { flexDirection: 'column' }, h(Text, null, 'Transcript')),
      )
    }

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, 'Prompt'),
      h(InputBox, { text: '', cursorPos: 0 }),
    )
  }

  const instance = render(h(RoundTripApp), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  setScreen?.('transcript')
  await instance.waitUntilRenderFlush()
  const transcriptOutput = stdout.writes.join('')

  stdout.writes.length = 0
  setScreen?.('prompt')
  await instance.waitUntilRenderFlush()
  const promptOutput = stdout.writes.join('')

  instance.unmount()

  assert.match(transcriptOutput, new RegExp(escapeRegExp(ENTER_ALT_SCREEN)))
  assert.match(promptOutput, new RegExp(escapeRegExp(EXIT_ALT_SCREEN)))
  assert.match(promptOutput, new RegExp(escapeRegExp(CLEAR_SCREEN + CURSOR_HOME)))
  assert.match(promptOutput, /Prompt/)
  assert.match(promptOutput, /\x1B\[2A\x1B\[3G/)
})

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
