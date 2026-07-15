import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCursorSuffix } from '../node_modules/ink/build/cursor-helpers.js'
import logUpdate from '../node_modules/ink/build/log-update.js'
import wrapText from '../node_modules/ink/build/wrap-text.js'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

const HIDE_CURSOR = '\x1B[?25l'
const SHOW_CURSOR = '\x1B[?25h'
const CANNOT_START_LINE = new Set(Array.from('，。！？、；：）】」』〉》〕］｝”’…—,.!?;:)]}'))
const CANNOT_END_LINE = new Set(Array.from('（【「『〈《〔［｛“‘([{'))

test('Ink CJK wrapping keeps closing punctuation off line starts and opening punctuation off line ends', () => {
  const content = '前文前文前文代码分析、文件编辑，命令执行。还有（括号内容）与【方括号】以及ASCII(test),done!结束'

  for (let width = 8; width <= 32; width++) {
    const wrapped = wrapText(content, width, 'wrap')
    const lines = wrapped.split('\n')

    assert.equal(lines.join(''), content, `width ${width} must preserve the original text`)
    for (const line of lines) {
      const characters = Array.from(line)
      assert.ok(!CANNOT_START_LINE.has(characters[0]!), `width ${width} starts with forbidden punctuation: ${line}`)
      assert.ok(!CANNOT_END_LINE.has(characters.at(-1)!), `width ${width} ends with forbidden punctuation: ${line}`)
    }
  }
})

test('Ink CJK wrapping does not orphan the screenshot ideographic comma at boundary widths', () => {
  const content = '我目前运行在 Windows 环境（PowerShell）下，位于 C:\\Users\\33731\\Documents\\code\\Hanekawa-main。我可以帮你进行代码分析、文件编辑、命令执行、任务规划等各种开发工作。'

  for (let width = 126; width <= 132; width++) {
    const wrapped = wrapText(content, width, 'wrap')
    const lines = wrapped.split('\n')

    assert.equal(lines.join(''), content, `width ${width} must not add visible break characters`)
    assert.ok(!lines.some(line => line.trim() === '、'), `width ${width} must not orphan the ideographic comma`)
    assert.ok(!lines.some(line => CANNOT_START_LINE.has(Array.from(line.trimStart())[0]!)))
  }
})

test('Ink wrapping preserves SGR sequences and visible widths', () => {
  const visible = '红色中文 mixed text 继续换行'
  const styled = `\x1b[38;2;255;0;0m${visible}\x1b[39m`

  for (let width = 4; width <= 18; width++) {
    const wrapped = wrapText(styled, width, 'wrap')
    assert.equal(stripAnsi(wrapped).replaceAll('\n', ''), visible)
    assert.ok(!stripAnsi(wrapped).includes('\x1b'), `width ${width} contains a broken ANSI escape`)
    for (const line of wrapped.split('\n')) {
      assert.ok(stringWidth(line) <= width, `width ${width} overflowed: ${JSON.stringify(line)}`)
    }
  }
})

test('Ink wrapping treats OSC hyperlinks as indivisible control sequences', () => {
  const visible = '中文链接与后续文字'
  const linked = `\x1b]8;;https://example.com\x1b\\中文链接\x1b]8;;\x1b\\与后续文字`

  for (let width = 4; width <= 12; width++) {
    const wrapped = wrapText(linked, width, 'wrap')
    assert.equal(stripAnsi(wrapped).replaceAll('\n', ''), visible)
    assert.ok(!stripAnsi(wrapped).includes('\x1b'), `width ${width} contains a broken OSC escape`)
  }
})

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
