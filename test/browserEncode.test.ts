import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ELEMENT_COLUMNS,
  clampMaxChars,
  elementsHeader,
  paginateLines,
  renderElementRow,
} from '../src/desktop/browser/encode.js'
import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { MAX_CHARS_MAX, MAX_CHARS_MIN } from '../src/desktop/browser/limits.js'

/**
 * The table and the pager, with no page and no cache in sight.
 *
 * What is worth asserting here is the compression — the column names appearing
 * once, the duplicate text collapsing, the flags folding into one field — and
 * the pager's two edges: a page that stops before the budget, and a single line
 * that cannot fit at all.
 */

test('a row drops text that merely repeats its name', () => {
  const line = renderElementRow({ ref: 'e1', role: 'link', name: 'Home', text: 'Home', visible: true })
  assert.equal(line, ['e1', 'link', 'Home', '', '', '', 'visible'].join('\t'))
})

test('bounds are one trailing column, present only when asked for', () => {
  const row = { ref: 'e1', role: 'button', name: 'Go', visible: true, bounds: [10, 20, 80, 24] as [number, number, number, number] }
  assert.equal(renderElementRow(row), ['e1', 'button', 'Go', '', '', '', 'visible'].join('\t'))
  assert.equal(renderElementRow(row, true), ['e1', 'button', 'Go', '', '', '', 'visible', '10,20,80,24'].join('\t'))
  assert.match(elementsHeader({ url: 'u', title: 't', scanTruncated: false }, 1, true), /\tflags\tbounds$/)
})

test('flags fold into one space-separated field, in a fixed order', () => {
  const line = renderElementRow({
    ref: 'e2',
    role: 'checkbox',
    checked: true,
    visible: true,
    required: true,
  })
  assert.equal(line.split('\t').at(-1), 'visible checked required')
})

test('an element scrolled out of view is flagged offscreen, after visible', () => {
  const line = renderElementRow({ ref: 'e3', role: 'button', name: 'Buy', visible: true, offscreen: true })
  assert.equal(line.split('\t').at(-1), 'visible offscreen')
})

test('the header names every column once and flags a truncated scan', () => {
  const header = elementsHeader({ url: 'https://x.test/', title: 'X', scanTruncated: true }, 12)
  const [meta, columns] = header.split('\n')
  assert.match(meta ?? '', /^# elements {2}url=https:\/\/x\.test\/ {2}title=X {2}total=12/)
  assert.match(meta ?? '', /scanTruncated=true/)
  assert.equal(columns, ELEMENT_COLUMNS.join('\t'))
})

test('a page stops at the budget and hands back a cursor', () => {
  const lines = Array.from({ length: 400 }, (_, index) => `e${index + 1}\tlink\tRow ${index + 1}`)
  const slice = paginateLines('# head', lines, 0, MAX_CHARS_MIN, (next) => `cur:${next}`)
  assert.ok(slice.nextOffset !== undefined && slice.nextOffset > 0)
  assert.ok(slice.text.length <= MAX_CHARS_MIN)
  assert.match(slice.text, /# more: \d+ remaining {2}cursor=cur:\d+$/)

  // The cursor resumes exactly where the first page stopped, with no gap.
  const second = paginateLines('# head', lines, slice.nextOffset ?? 0, MAX_CHARS_MIN, (next) => `cur:${next}`)
  assert.ok(second.text.includes(lines[slice.nextOffset ?? 0] as string))
})

test('the last page carries no cursor', () => {
  const slice = paginateLines('# head', ['a', 'b'], 0, MAX_CHARS_MIN, () => 'cur')
  assert.equal(slice.nextOffset, undefined)
  assert.equal(slice.text, '# head\na\nb')
})

test('a single oversized row is an error, not an empty page', () => {
  const lines = ['x'.repeat(MAX_CHARS_MIN * 2)]
  assert.throws(
    () => paginateLines('# head', lines, 0, MAX_CHARS_MIN, () => 'cur'),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OUTPUT_LIMIT',
  )
})

test('maxChars is clamped, and absent means the caller default', () => {
  assert.equal(clampMaxChars(undefined, 8000), 8000)
  assert.equal(clampMaxChars(10, 8000), MAX_CHARS_MIN)
  assert.equal(clampMaxChars(10 ** 9, 8000), MAX_CHARS_MAX)
  assert.equal(clampMaxChars(Number.NaN, 8000), 8000)
})
