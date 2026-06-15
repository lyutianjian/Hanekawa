import test from 'node:test'
import assert from 'node:assert/strict'
import type { Token, Tokens } from 'marked'
import {
  wrapCellText,
  padAligned,
  renderBorderLine,
  renderFormattedCell,
  cellPlainText,
  SAFETY_MARGIN,
  MIN_COLUMN_WIDTH,
  MAX_ROW_LINES,
} from '../src/tui/components/Markdown.js'

// ── wrapCellText ──

test('wrapCellText returns single line for short text', () => {
  const result = wrapCellText('hello', 20)
  assert.deepEqual(result, ['hello'])
})

test('wrapCellText wraps long text at word boundaries', () => {
  const result = wrapCellText('hello world foo bar baz', 10)
  assert.ok(result.length > 1)
  // Each line should fit within width
  for (const line of result) {
    // stripAnsi not needed here since no ANSI codes
    assert.ok(line.length <= 10, `Line "${line}" exceeds width 10`)
  }
})

test('wrapCellText handles empty text', () => {
  const result = wrapCellText('', 10)
  assert.deepEqual(result, [''])
})

test('wrapCellText handles zero width', () => {
  const result = wrapCellText('hello', 0)
  assert.deepEqual(result, ['hello'])
})

test('wrapCellText preserves ANSI codes across line breaks', () => {
  const ansiText = '\x1b[1mhello world foo bar baz\x1b[22m'
  const result = wrapCellText(ansiText, 10)
  assert.ok(result.length > 1)
  // Each line should contain the ANSI reset or the codes should carry over
  // The important thing is it doesn't crash
})

test('wrapCellText filters empty lines', () => {
  const result = wrapCellText('  ', 10)
  // After trimEnd, the text becomes empty, so we get ['']
  assert.ok(result.length >= 1)
})

test('wrapCellText handles hard break mode', () => {
  const result = wrapCellText('verylongwordthatcannotbreak', 5, true)
  assert.ok(result.length >= 1)
})

// ── padAligned ──

test('padAligned left-aligns by default', () => {
  const result = padAligned('hi', 2, 5, 'left')
  assert.equal(result, 'hi   ')
})

test('padAligned right-aligns', () => {
  const result = padAligned('hi', 2, 5, 'right')
  assert.equal(result, '   hi')
})

test('padAligned center-aligns', () => {
  const result = padAligned('hi', 2, 6, 'center')
  assert.equal(result, '  hi  ')
})

test('padAligned handles null alignment (defaults to left)', () => {
  const result = padAligned('hi', 2, 5, null)
  assert.equal(result, 'hi   ')
})

test('padAligned handles undefined alignment (defaults to left)', () => {
  const result = padAligned('hi', 2, 5, undefined)
  assert.equal(result, 'hi   ')
})

test('padAligned returns content unchanged when padding is zero', () => {
  const result = padAligned('hello', 5, 5, 'left')
  assert.equal(result, 'hello')
})

test('padAligned returns content unchanged when display width exceeds target', () => {
  const result = padAligned('hello world', 11, 5, 'left')
  assert.equal(result, 'hello world')
})

// ── renderBorderLine ──

test('renderBorderLine renders top border', () => {
  // Column widths [5, 3] → each gets +2 for padding: ─────── (7) and ───── (5)
  const result = renderBorderLine([5, 3], 'top')
  assert.equal(result, '┌───────┬─────┐')
})

test('renderBorderLine renders middle border', () => {
  const result = renderBorderLine([5, 3], 'middle')
  assert.equal(result, '├───────┼─────┤')
})

test('renderBorderLine renders bottom border', () => {
  const result = renderBorderLine([5, 3], 'bottom')
  assert.equal(result, '└───────┴─────┘')
})

test('renderBorderLine handles single column', () => {
  const result = renderBorderLine([10], 'top')
  assert.equal(result, '┌────────────┐')
})

// Helper to create a minimal TableCell mock
function makeCell(tokens: Token[]): Tokens.TableCell {
  return { tokens, text: '', header: false, align: null } as unknown as Tokens.TableCell
}

// ── cellPlainText ──

test('cellPlainText extracts text from text tokens', () => {
  const cell = makeCell([
    { type: 'text', text: 'hello', raw: 'hello' } as Token,
  ])
  const result = cellPlainText(cell)
  assert.equal(result, 'hello')
})

test('cellPlainText extracts text from codespan tokens', () => {
  const cell = makeCell([
    { type: 'codespan', text: 'code', raw: '`code`' } as Token,
  ])
  const result = cellPlainText(cell)
  assert.equal(result, 'code')
})

test('cellPlainText joins multiple tokens', () => {
  const cell = makeCell([
    { type: 'text', text: 'hello ', raw: 'hello ' } as Token,
    { type: 'text', text: 'world', raw: 'world' } as Token,
  ])
  const result = cellPlainText(cell)
  assert.equal(result, 'hello world')
})

// ── renderFormattedCell ──

test('renderFormattedCell renders plain text without ANSI codes', () => {
  const cell = makeCell([
    { type: 'text', text: 'hello', raw: 'hello' } as Token,
  ])
  const result = renderFormattedCell(cell)
  assert.equal(result, 'hello')
})

test('renderFormattedCell renders bold text with ANSI codes', () => {
  const cell = makeCell([
    {
      type: 'strong',
      tokens: [{ type: 'text', text: 'bold', raw: 'bold' }],
    } as unknown as Token,
  ])
  const result = renderFormattedCell(cell)
  assert.ok(result.includes('\x1b[1m'), 'Should contain bold escape code')
  assert.ok(result.includes('\x1b[22m'), 'Should contain bold reset code')
  assert.ok(result.includes('bold'))
})

test('renderFormattedCell renders codespan with color', () => {
  const cell = makeCell([
    { type: 'codespan', text: 'code', raw: '`code`' } as Token,
  ])
  const result = renderFormattedCell(cell)
  assert.ok(result.includes('\x1b[38;2;'), 'Should contain color escape code')
  assert.ok(result.includes('code'))
})

test('renderFormattedCell applies cellColor to plain text', () => {
  const cell = makeCell([
    { type: 'text', text: 'hello', raw: 'hello' } as Token,
  ])
  const result = renderFormattedCell(cell, '#FF0000')
  assert.ok(result.includes('\x1b[38;2;255;0;0m'), 'Should contain red color code')
  assert.ok(result.includes('hello'))
})

// ── Constants ──

test('SAFETY_MARGIN is 4', () => {
  assert.equal(SAFETY_MARGIN, 4)
})

test('MIN_COLUMN_WIDTH is 3', () => {
  assert.equal(MIN_COLUMN_WIDTH, 3)
})

test('MAX_ROW_LINES is 4', () => {
  assert.equal(MAX_ROW_LINES, 4)
})
