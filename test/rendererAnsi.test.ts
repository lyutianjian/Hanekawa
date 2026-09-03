import test from 'node:test'
import assert from 'node:assert/strict'

import { stripAnsi } from '../src/desktop/renderer/model/ansi.js'

/**
 * The stripping half of the renderer's ANSI handling (T14, §6.4): shell output
 * arrives with the escapes the command emitted, and a text node prints them as
 * `[32m` garbage. Colour rendering is deliberately a later stage — an
 * ANSI→span pure function would live beside this one in `model/` — so what this
 * file pins is the *whole* contract of the current stage: every sequence shape a
 * real tool emits is gone, and everything that is not a sequence survives.
 */

test('SGR colour sequences go — 16, 256, truecolor, colon form, and the reset', () => {
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m'), 'green')
  assert.equal(stripAnsi('\x1b[38;5;123m256m\x1b[0m'), '256m')
  assert.equal(stripAnsi('\x1b[38;2;10;20;30mrgb\x1b[0m'), 'rgb')
  // `:`-separated SGR is the modern spelling (sub-parameter form).
  assert.equal(stripAnsi('\x1b[38:2:10:20:30mrgb\x1b[m'), 'rgb')
  assert.equal(stripAnsi('\x1b[1;31mbold red\x1b[39;49m'), 'bold red')
  // Empty params and partial resets are still sequences.
  assert.equal(stripAnsi('\x1b[mplain\x1b[0K'), 'plain')
})

test('cursor and erase sequences go, including private modes', () => {
  // A progress line's toolkit: erase line, column jump, hide cursor, alt screen.
  assert.equal(stripAnsi('\x1b[2K\x1b[1Gdone'), 'done')
  assert.equal(stripAnsi('\x1b[?25lh\x1b[?1049h'), 'h')
  // Intermediates before the final byte (`ESC [ 0 SP q`).
  assert.equal(stripAnsi('\x1b[0 qcursor style'), 'cursor style')
})

test('OSC strings go with their terminators, BEL and ST both', () => {
  // A window title set with BEL.
  assert.equal(stripAnsi('\x1b]0;npm test\x07output'), 'output')
  // A hyperlink (OSC 8) with the ST terminator — payload and both halves.
  assert.equal(stripAnsi('\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x07'), 'link')
  // DCS and friends are the same shape (P/X/^/_ openers).
  assert.equal(stripAnsi('\x1bP+q544f\x1b\\ok'), 'ok')
})

test('an unterminated string sequence eats the tail, as a terminal would', () => {
  // Output truncated at the 1MB cap mid-OSC: the payload is not content.
  assert.equal(stripAnsi('keep\x1b]0;title that never'), 'keep')
  assert.equal(stripAnsi('\x1b]8;;http://x'), '')
})

test('two-character escapes go, with and without intermediates', () => {
  // Save/restore cursor.
  assert.equal(stripAnsi('\x1b7saved\x1b8'), 'saved')
  // Charset designation is `ESC ( B` — an intermediate then the final.
  assert.equal(stripAnsi('\x1b(Bascii'), 'ascii')
  // A lone trailing ESC — malformed, and never content.
  assert.equal(stripAnsi('tail\x1b'), 'tail')
})

test('text that is not a sequence survives untouched', () => {
  assert.equal(stripAnsi('plain output'), 'plain output')
  // A `\r` is not an escape sequence (module doc): CSS renders it as a line
  // break, so a progress line degrades into lines rather than into mojibake.
  assert.equal(stripAnsi('10%\r100%'), '10%\r100%')
  // CJK and the characters that mimic sequence syntax when the ESC is gone.
  assert.equal(stripAnsi('通过 [32m 不是转义'), '通过 [32m 不是转义')
  assert.equal(stripAnsi('1;31m no esc here'), '1;31m no esc here')
})

test('a realistic mixed line is stripped to its text', () => {
  const noisy = '\x1b[?25lnpm test\x1b[32m\r\x1b[2K\x1b[1G\x1b[32m\u2713\x1b[0m 42 passed\x1b[0m\x1b[?25h'
  assert.equal(stripAnsi(noisy), 'npm test\r✓ 42 passed')
})
