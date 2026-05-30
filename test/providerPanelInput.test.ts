import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTextInputKey, type InkKey } from '../src/tui/components/ProviderPanel.js'

const empty: InkKey = {}

test('applyTextInputKey: insert printable at cursor', () => {
  // Cursor in the middle of "abce", press "d" -> "abcde"
  const out = applyTextInputKey('abce', 3, 'd', empty)
  assert.equal(out.value, 'abcde')
  assert.equal(out.cursor, 4)
})

test('applyTextInputKey: insert at start', () => {
  const out = applyTextInputKey('bcd', 0, 'a', empty)
  assert.equal(out.value, 'abcd')
  assert.equal(out.cursor, 1)
})

test('applyTextInputKey: insert at end', () => {
  const out = applyTextInputKey('abc', 3, 'd', empty)
  assert.equal(out.value, 'abcd')
  assert.equal(out.cursor, 4)
})

test('applyTextInputKey: backspace at end deletes last char', () => {
  const out = applyTextInputKey('abcd', 4, '', { backspace: true })
  assert.equal(out.value, 'abc')
  assert.equal(out.cursor, 3)
})

test('applyTextInputKey: backspace mid-string deletes char before cursor', () => {
  // "abXcd" with cursor 2 -> backspace removes "X" -> "abcd" cursor 1? wait.
  // Actually "abcd" with cursor=2 means the cursor sits between 'b' and 'c'.
  // Backspace removes 'b' -> "acd", cursor=1.
  const out = applyTextInputKey('abcd', 2, '', { backspace: true })
  assert.equal(out.value, 'acd')
  assert.equal(out.cursor, 1)
})

test('applyTextInputKey: backspace at start is a no-op', () => {
  const out = applyTextInputKey('abcd', 0, '', { backspace: true })
  assert.equal(out.value, 'abcd')
  assert.equal(out.cursor, 0)
})

test('applyTextInputKey: delete removes char at cursor', () => {
  const out = applyTextInputKey('abcd', 1, '', { delete: true })
  assert.equal(out.value, 'acd')
  assert.equal(out.cursor, 1)
})

test('applyTextInputKey: delete at end is a no-op', () => {
  const out = applyTextInputKey('abcd', 4, '', { delete: true })
  assert.equal(out.value, 'abcd')
  assert.equal(out.cursor, 4)
})

test('applyTextInputKey: leftArrow moves cursor left, clamped at 0', () => {
  assert.equal(applyTextInputKey('abc', 2, '', { leftArrow: true }).cursor, 1)
  assert.equal(applyTextInputKey('abc', 0, '', { leftArrow: true }).cursor, 0)
})

test('applyTextInputKey: rightArrow moves cursor right, clamped at length', () => {
  assert.equal(applyTextInputKey('abc', 1, '', { rightArrow: true }).cursor, 2)
  assert.equal(applyTextInputKey('abc', 3, '', { rightArrow: true }).cursor, 3)
})

test('applyTextInputKey: home / Ctrl+A jump to start', () => {
  assert.equal(applyTextInputKey('abc', 2, '', { home: true }).cursor, 0)
  assert.equal(applyTextInputKey('abc', 2, 'a', { ctrl: true }).cursor, 0)
})

test('applyTextInputKey: end / Ctrl+E jump to end', () => {
  assert.equal(applyTextInputKey('abc', 0, '', { end: true }).cursor, 3)
  assert.equal(applyTextInputKey('abc', 0, 'e', { ctrl: true }).cursor, 3)
})

test('applyTextInputKey: control characters are ignored', () => {
  // Escape sequence-ish low-byte input must not be inserted.
  const out = applyTextInputKey('abc', 1, '\u001b', empty)
  assert.equal(out.value, 'abc')
  assert.equal(out.cursor, 1)
})

test('applyTextInputKey: ctrl-modified keys (other than a/e) are ignored', () => {
  const out = applyTextInputKey('abc', 1, 'k', { ctrl: true })
  assert.equal(out.value, 'abc')
  assert.equal(out.cursor, 1)
})

test('applyTextInputKey: multi-char paste inserts wholesale and advances cursor', () => {
  const out = applyTextInputKey('aZ', 1, 'BCD', empty)
  assert.equal(out.value, 'aBCDZ')
  assert.equal(out.cursor, 4)
})

test('applyTextInputKey: cursor beyond value length is clamped silently', () => {
  // Stale cursor (> value.length) shouldn't crash.
  const out = applyTextInputKey('ab', 99, 'x', empty)
  assert.equal(out.value, 'abx')
  assert.equal(out.cursor, 3)
})

test('applyTextInputKey: negative cursor is clamped to 0', () => {
  const out = applyTextInputKey('ab', -5, 'x', empty)
  assert.equal(out.value, 'xab')
  assert.equal(out.cursor, 1)
})
