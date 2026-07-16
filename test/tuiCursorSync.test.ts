import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createElement as h, useState } from 'react'
import ansiEscapes from 'ansi-escapes'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

import { Box, render, Static, Text, snapshotInkFrameForStdout, useStdout } from '../src/tui/ink.js'
import type { InkFrameSnapshot } from '../src/tui/ink.js'
import { InputBox } from '../src/tui/components/InputBox.js'
import { AlternateScreen } from '../src/tui/components/AlternateScreen.js'
import { WelcomeBanner } from '../src/tui/components/WelcomeBanner.js'

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

test('InputBox follows terminal width changes without input state updates', async () => {
  const stdout = createFakeStdout()
  const text = 'alpha 你好 🙂 beta gamma delta epsilon zeta\nsecond line'
  const instance = render(h(InputBox, { text, cursorPos: text.length }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()

  for (const columns of [40, 20, 60, 20, 80]) {
    stdout.resizeTo(columns)
    await waitForResize(instance)

    const snapshot = snapshotInkFrameForStdout(stdout)
    assert.ok(snapshot)
    const lines = stripAnsi(snapshot.lastOutput).split('\n')
    const separatorLines = lines.filter(isSeparatorLine)
    const safeWidth = Math.max(1, columns - 1)

    assert.equal(separatorLines.length, 2)
    assert.ok(separatorLines.every((line) => stringWidth(line) === safeWidth))
    assert.ok(lines.every((line) => stringWidth(line) <= safeWidth))
    assert.ok(snapshot.cursorPosition)
    assert.ok(snapshot.cursorPosition.x < safeWidth)
    assert.ok(snapshot.cursorPosition.y >= 0)
    assert.ok(snapshot.cursorPosition.y < lines.length)
  }

  instance.unmount()
})

test('Ink uses reflow-aware resize clearing only in Windows Terminal', async () => {
  const previousWtSession = process.env.WT_SESSION

  try {
    process.env.WT_SESSION = 'test-windows-terminal'
    const windowsOutput = await captureImmediateResizeOutput(120, 80)
    assert.match(windowsOutput, new RegExp(escapeRegExp(ansiEscapes.eraseLines(6))))

    delete process.env.WT_SESSION
    const fallbackOutput = await captureImmediateResizeOutput(120, 80)
    assert.match(fallbackOutput, new RegExp(escapeRegExp(ansiEscapes.eraseLines(4))))
    assert.doesNotMatch(fallbackOutput, new RegExp(escapeRegExp(ansiEscapes.eraseLines(6))))
  } finally {
    if (previousWtSession === undefined) delete process.env.WT_SESSION
    else process.env.WT_SESSION = previousWtSession
  }
})

test('Windows Terminal rapid resize bursts settle on one clean input frame', async () => {
  const previousWtSession = process.env.WT_SESSION
  process.env.WT_SESSION = 'test-windows-terminal'
  const stdout = createFakeStdout(120)
  const text = 'alpha 你好 🙂 beta gamma delta epsilon zeta'
  const instance = render(h(InputBox, { text, cursorPos: text.length }), {
    stdout,
    exitOnCtrlC: false,
  })

  try {
    await instance.waitUntilRenderFlush()
    stdout.writes.length = 0

    for (const columns of [80, 110, 60]) stdout.resizeTo(columns)
    await waitForResize(instance)

    const output = stdout.writes.join('')
    const reflowClears = output.split(ansiEscapes.eraseLines(6)).length - 1
    assert.equal(reflowClears, 2)

    const snapshot = snapshotInkFrameForStdout(stdout)
    assert.ok(snapshot)
    const lines = stripAnsi(snapshot.lastOutput).split('\n')
    assert.equal(lines.filter(isSeparatorLine).length, 2)
    assert.ok(lines.every((line) => stringWidth(line) <= 59))
    assert.ok(snapshot.cursorPosition)
    assert.ok(snapshot.cursorPosition.x < 59)
    assert.ok(snapshot.cursorPosition.y >= 0)
    assert.ok(snapshot.cursorPosition.y < lines.length)
  } finally {
    instance.unmount()
    if (previousWtSession === undefined) delete process.env.WT_SESSION
    else process.env.WT_SESSION = previousWtSession
  }
})

test('InputBox keeps disabled and streaming frames within the resized terminal', async () => {
  const stdout = createFakeStdout()
  const text = '123456789012345678901234567890'
  const instance = render(h(InputBox, {
    text,
    cursorPos: text.length,
    isStreaming: true,
  }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.resizeTo(20)
  await waitForResize(instance)

  const snapshot = snapshotInkFrameForStdout(stdout)
  assert.ok(snapshot)
  const lines = stripAnsi(snapshot.lastOutput).split('\n')
  assert.ok(lines.every((line) => stringWidth(line) <= 19))
  assert.match(stripAnsi(snapshot.lastOutput), /Enter to queue/)
  assert.ok(snapshot.cursorPosition)
  assert.ok(snapshot.cursorPosition.x < 19)

  instance.rerender(h(InputBox, {
    text,
    cursorPos: text.length,
    disabled: true,
  }))
  await instance.waitUntilRenderFlush()
  assert.equal(snapshotInkFrameForStdout(stdout)?.cursorPosition, undefined)

  instance.unmount()
})

test('WelcomeBanner fills the safe initial width inside Static', async () => {
  for (const columns of [69, 70, 80, 120]) {
    const stdout = createFakeStdout(columns)
    const bannerProps = {
      sessionShortId: 'abc12345',
      model: 'step-3.7-flash-with-a-long-model-name',
      providerName: 'anthropic-compatible-provider',
      cwd: 'C:\\repo\\with\\a\\long\\working\\directory',
    }
    const instance = render(
      h(Box, { flexDirection: 'column', width: '100%' },
        h(Static<{ id: string }>, {
          items: [{ id: `banner-${columns}` }],
          children: (item) => h(WelcomeBanner, { key: item.id, ...bannerProps }),
        })),
      { stdout, exitOnCtrlC: false },
    )

    await instance.waitUntilRenderFlush()
    const snapshot = snapshotInkFrameForStdout(stdout)
    assert.ok(snapshot)
    const lines = stripAnsi(snapshot.fullStaticOutput).split('\n').filter(Boolean)
    const safeWidth = columns - 1

    assert.ok(lines.length > 0)
    assert.equal(Math.max(...lines.map((line) => stringWidth(line))), safeWidth)
    assert.ok(lines.every((line) => stringWidth(line) <= safeWidth))

    instance.unmount()
  }
})

type FakeStdout = NodeJS.WriteStream & {
  writes: string[]
  resizeTo(columns: number): void
}

function createFakeStdout(columns = 40): FakeStdout {
  const writes: string[] = []
  const stdout = new EventEmitter() as FakeStdout
  stdout.rows = 10
  stdout.columns = columns
  stdout.isTTY = true
  stdout.writes = writes
  stdout.write = function write(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
  ) {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (done) queueMicrotask(() => done())
    return true
  } as NodeJS.WriteStream['write']
  stdout.resizeTo = (nextColumns: number) => {
    stdout.columns = nextColumns
    stdout.emit('resize')
  }
  return stdout
}

async function waitForResize(instance: { waitUntilRenderFlush(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  await instance.waitUntilRenderFlush()
}

async function captureImmediateResizeOutput(fromColumns: number, toColumns: number): Promise<string> {
  const stdout = createFakeStdout(fromColumns)
  const instance = render(h(InputBox, { text: '', cursorPos: 0 }), {
    stdout,
    exitOnCtrlC: false,
  })

  await instance.waitUntilRenderFlush()
  stdout.writes.length = 0
  stdout.resizeTo(toColumns)
  const output = stdout.writes.join('')
  await waitForResize(instance)
  instance.unmount()
  return output
}

function isSeparatorLine(line: string): boolean {
  return line.length > 0 && line.replaceAll('─', '') === ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
