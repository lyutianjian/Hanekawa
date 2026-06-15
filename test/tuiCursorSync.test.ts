import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h, useState } from 'react'

import { Box, render, Static, Text, snapshotInkFrameForStdout, useStdout } from '../src/tui/ink.js'
import type { InkFrameSnapshot } from '../src/tui/ink.js'
import { InputBox } from '../src/tui/components/InputBox.js'
import { AlternateScreen } from '../src/tui/components/AlternateScreen.js'

const ENTER_ALT_SCREEN = '\x1B[?1049h'
const EXIT_ALT_SCREEN = '\x1B[?1049l'
const ENABLE_ALT_SCROLL = '\x1B[?1007h'
const DISABLE_ALT_SCROLL = '\x1B[?1007l'
const ENABLE_SGR_MOUSE = '\x1B[?1006h'
const DISABLE_SGR_MOUSE = '\x1B[?1006l'
const ENABLE_MOUSE_TRACKING = '\x1B[?1000h'
const DISABLE_MOUSE_TRACKING = '\x1B[?1000l'
const CLEAR_SCREEN = '\x1B[2J'
const CURSOR_HOME = '\x1B[H'

interface StaticHistoryItem {
  id: string
  label: string
}

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

test('prompt view preserves static history after alternate-screen round trip', async () => {
  const stdout = createFakeStdout()
  let openTranscript: (() => void) | undefined
  let closeTranscript: (() => void) | undefined
  let appendStatic: ((label: string) => void) | undefined

  function RoundTripApp() {
    const [screen, nextSetScreen] = useState<'prompt' | 'transcript'>('prompt')
    const [items, setItems] = useState<StaticHistoryItem[]>(() => [{ id: 'old', label: 'OLD-HISTORY' }])
    const [frozenStaticCount, setFrozenStaticCount] = useState<number | null>(null)
    const [promptFrameSnapshot, setPromptFrameSnapshot] = useState<InkFrameSnapshot | undefined>(undefined)
    const { stdout: inkStdout } = useStdout()

    openTranscript = () => {
      setPromptFrameSnapshot(snapshotInkFrameForStdout(inkStdout))
      setFrozenStaticCount(items.length)
      nextSetScreen('transcript')
    }
    closeTranscript = () => {
      setFrozenStaticCount(null)
      nextSetScreen('prompt')
    }
    appendStatic = (label: string) => {
      setItems((previous) => [...previous, { id: label, label }])
    }

    const staticItems = frozenStaticCount === null ? items : items.slice(0, frozenStaticCount)

    return h(
      Box,
      { flexDirection: 'column' },
      h(Static<StaticHistoryItem>, {
        items: staticItems,
        children: (item) => h(Text, { key: item.id }, item.label),
      }),
      screen === 'transcript'
        ? h(
          AlternateScreen,
          { promptFrameSnapshot },
          h(Box, { flexDirection: 'column' }, h(Text, null, 'Transcript')),
        )
        : h(
          Box,
          { flexDirection: 'column' },
          h(Text, null, 'Prompt'),
          h(InputBox, { text: '', cursorPos: 0 }),
        ),
    )
  }

  const instance = render(h(RoundTripApp), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  openTranscript?.()
  await instance.waitUntilRenderFlush()
  const transcriptOutput = stdout.writes.join('')

  stdout.writes.length = 0
  appendStatic?.('NEW-HISTORY')
  await instance.waitUntilRenderFlush()
  const whileTranscriptOutput = stdout.writes.join('')

  stdout.writes.length = 0
  closeTranscript?.()
  await instance.waitUntilRenderFlush()
  const promptOutput = stdout.writes.join('')

  instance.unmount()

  assert.match(transcriptOutput, new RegExp(escapeRegExp(ENTER_ALT_SCREEN)))
  assert.match(transcriptOutput, new RegExp(escapeRegExp(ENABLE_ALT_SCROLL)))
  assert.match(transcriptOutput, new RegExp(escapeRegExp(ENABLE_SGR_MOUSE)))
  assert.match(transcriptOutput, new RegExp(escapeRegExp(ENABLE_MOUSE_TRACKING)))
  assert.ok(transcriptOutput.indexOf(ENTER_ALT_SCREEN) < transcriptOutput.indexOf(ENABLE_ALT_SCROLL))
  assert.ok(transcriptOutput.indexOf(ENABLE_ALT_SCROLL) < transcriptOutput.indexOf(ENABLE_SGR_MOUSE))
  assert.ok(transcriptOutput.indexOf(ENABLE_SGR_MOUSE) < transcriptOutput.indexOf(ENABLE_MOUSE_TRACKING))
  assert.match(transcriptOutput, /Transcript/)
  assert.doesNotMatch(transcriptOutput, /OLD-HISTORY/)
  assert.doesNotMatch(whileTranscriptOutput, /NEW-HISTORY/)
  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_MOUSE_TRACKING)))
  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_SGR_MOUSE)))
  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_ALT_SCROLL)))
  assert.match(promptOutput, new RegExp(escapeRegExp(EXIT_ALT_SCREEN)))
  assert.ok(promptOutput.indexOf(DISABLE_MOUSE_TRACKING) < promptOutput.indexOf(DISABLE_SGR_MOUSE))
  assert.ok(promptOutput.indexOf(DISABLE_SGR_MOUSE) < promptOutput.indexOf(DISABLE_ALT_SCROLL))
  assert.ok(promptOutput.indexOf(DISABLE_ALT_SCROLL) < promptOutput.indexOf(EXIT_ALT_SCREEN))
  assert.doesNotMatch(promptOutput, new RegExp(escapeRegExp(CLEAR_SCREEN + CURSOR_HOME)))
  assert.doesNotMatch(promptOutput, /OLD-HISTORY/)
  assert.match(promptOutput, /NEW-HISTORY/)
})

test('alternate-screen round trip preserves prompt cursor anchor after live summary', async () => {
  const stdout = createFakeStdout()
  let openTranscript: (() => void) | undefined
  let closeTranscript: (() => void) | undefined

  function PromptLikeApp() {
    const [screen, nextSetScreen] = useState<'prompt' | 'transcript'>('prompt')
    const [promptFrameSnapshot, setPromptFrameSnapshot] = useState<InkFrameSnapshot | undefined>(undefined)
    const { stdout: inkStdout } = useStdout()

    openTranscript = () => {
      setPromptFrameSnapshot(snapshotInkFrameForStdout(inkStdout))
      nextSetScreen('transcript')
    }
    closeTranscript = () => {
      nextSetScreen('prompt')
    }

    return h(
      Box,
      { flexDirection: 'column' },
      screen === 'transcript'
        ? h(
          AlternateScreen,
          { promptFrameSnapshot },
          h(Box, { flexDirection: 'column' }, h(Text, null, 'Transcript')),
        )
        : h(
          Box,
          { flexDirection: 'column' },
          h(Text, null, '* Worked for 4s'),
          h(InputBox, { text: '', cursorPos: 0 }),
          h(Text, null, 'STATUS-LINE'),
        ),
    )
  }

  const instance = render(h(PromptLikeApp), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  openTranscript?.()
  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0

  closeTranscript?.()
  await instance.waitUntilRenderFlush()
  const promptOutput = stdout.writes.join('')

  instance.unmount()

  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_MOUSE_TRACKING)))
  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_SGR_MOUSE)))
  assert.match(promptOutput, new RegExp(escapeRegExp(DISABLE_ALT_SCROLL)))
  assert.match(promptOutput, new RegExp(escapeRegExp(EXIT_ALT_SCREEN)))
  assert.ok(promptOutput.indexOf(DISABLE_MOUSE_TRACKING) < promptOutput.indexOf(DISABLE_SGR_MOUSE))
  assert.ok(promptOutput.indexOf(DISABLE_SGR_MOUSE) < promptOutput.indexOf(DISABLE_ALT_SCROLL))
  assert.ok(promptOutput.indexOf(DISABLE_ALT_SCROLL) < promptOutput.indexOf(EXIT_ALT_SCREEN))
  assert.doesNotMatch(promptOutput, /\x1B\[\d+A\x1B\[\d+G/)
  assert.doesNotMatch(promptOutput, /\* Worked for 4s/)
  assert.doesNotMatch(promptOutput, /STATUS-LINE/)
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
