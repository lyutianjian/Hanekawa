import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { theme } from '../src/tui/theme.js'

test('TUI application colors use zero-saturation grayscale values', () => {
  const uiColors = [
    theme.brand,
    theme.userPrefix,
    theme.assistantText,
    theme.dimText,
    theme.subtleText,
    theme.toolName,
    theme.statusDotSuccess,
    theme.statusDotFailed,
    theme.success,
    theme.error,
    theme.warning,
    theme.border,
    theme.spinner,
    theme.inputPrompt,
    theme.systemText,
    theme.taskRunning,
    theme.taskDone,
    theme.taskFailed,
    theme.taskDim,
    theme.codeBg,
    theme.codeInline,
    ...theme.spinnerPalette.flatMap(({ base, shimmer }) => [base, shimmer]),
  ]

  for (const color of uiColors) {
    const [red, green, blue] = parseColor(color)
    assert.equal(red, green, `${color} is not grayscale`)
    assert.equal(green, blue, `${color} is not grayscale`)
  }

  assert.equal(theme.brand, '#F2F2F2')
  assert.equal(theme.error, '#FFFFFF')
  assert.equal(theme.codeBg, '#000000')
})

test('Markdown retains its established colors and syntax highlighting', () => {
  assert.deepEqual(theme.markdown, {
    brand: '#60A5FA',
    dimText: '#808080',
    subtleText: '#909090',
    toolName: '#87CEEB',
    success: '#90EE90',
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
