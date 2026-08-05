import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { theme } from '../src/tui/theme.js'

test('TUI neutral UI colors use zero-saturation grayscale values', () => {
  const neutralColors = [
    theme.brand,
    theme.userPrefix,
    theme.assistantText,
    theme.dimText,
    theme.subtleText,
    theme.toolName,
    theme.border,
    theme.spinner,
    theme.inputPrompt,
    theme.systemText,
    theme.taskDim,
    theme.codeBg,
    theme.codeInline,
    ...theme.spinnerPalette.flatMap(({ base, shimmer }) => [base, shimmer]),
  ]

  for (const color of neutralColors) {
    const [red, green, blue] = parseColor(color)
    assert.equal(red, green, `${color} is not grayscale`)
    assert.equal(green, blue, `${color} is not grayscale`)
  }

  assert.equal(theme.brand, '#F2F2F2')
  assert.equal(theme.codeBg, '#000000')
})

test('TUI semantic colors carry meaning (non-grayscale)', () => {
  assert.equal(theme.statusDotSuccess, 'rgb(78,186,101)')
  assert.equal(theme.statusDotFailed, 'rgb(255,107,128)')
  assert.equal(theme.success, '#90EE90')
  assert.equal(theme.error, '#FF6B6B')
  assert.equal(theme.warning, '#FFD700')
  assert.equal(theme.taskRunning, '#8AB4F8')
  assert.equal(theme.taskDone, '#90EE90')
  assert.equal(theme.taskFailed, '#FF6B6B')
})

test('Markdown retains its established colors and syntax highlighting', () => {
  assert.deepEqual(theme.markdown, {
    brand: '#60A5FA',
    dimText: '#808080',
    subtleText: '#909090',
    toolName: '#87CEEB',
    success: '#90EE90',
    error: '#FF6B6B',
    warning: '#FFD700',
    codeBg: '#1E1E1E',
    codeInline: '#CBA6F7',
  })

  assert.deepEqual(theme.syntax, {
    keyword: '#CBA6F7',
    builtIn: '#F38BA8',
    type: '#F9E2AF',
    literal: '#A6E3A1',
    number: '#FAB387',
    regexp: '#F5C2E7',
    string: '#A6E3A1',
    comment: '#6C7086',
    function: '#89B4FA',
    title: '#89B4FA',
    params: '#CDD6F4',
    meta: '#F38BA8',
    tag: '#F38BA8',
    name: '#89B4FA',
    attr: '#F9E2AF',
    section: '#89B4FA',
    class: '#F9E2AF',
    default: '#CDD6F4',
  })
})

test('Markdown uses its preserved palette and user messages remain neutral', async () => {
  const markdownSource = await readFile('src/tui/components/Markdown.tsx', 'utf8')
  const userMessageSource = await readFile('src/tui/components/UserMessage.tsx', 'utf8')

  assert.match(markdownSource, /const theme = \{ \.\.\.appTheme, \.\.\.appTheme\.markdown \}/)
  assert.match(userMessageSource, /backgroundColor="#2d2d2d"/)
  assert.match(userMessageSource, /color="white"/)
})

function parseColor(color: string): [number, number, number] {
  const hex = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(color)
  if (hex) return [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16), Number.parseInt(hex[3]!, 16)]

  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color)
  assert.ok(rgb, `Unsupported color format: ${color}`)
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
}
