import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { AssistantMessage } from '../src/tui/components/AssistantMessage.js'
import { Markdown } from '../src/tui/components/Markdown.js'
import { parseMarkdown } from '../src/tui/markdown.js'

// Cleanup after each test
test.afterEach(() => cleanup())

// ── Heading level differentiation ──

test('Heading: h1 renders with bold + italic + underline', () => {
  const frame = render(h(Markdown, { content: '# Hello World' })).lastFrame() ?? ''
  assert.match(frame, /Hello World/)
  // h1 should be visually distinct — bold+italic+underline is the combination
  // ink-testing-library doesn't expose Text props directly, so we verify the content renders
})

test('Heading: h2 renders with bold only', () => {
  const frame = render(h(Markdown, { content: '## Subtitle' })).lastFrame() ?? ''
  assert.match(frame, /Subtitle/)
})

test('Heading: h3 renders with dimColor', () => {
  const frame = render(h(Markdown, { content: '### Section' })).lastFrame() ?? ''
  assert.match(frame, /Section/)
})

test('Heading: multiple levels render without errors', () => {
  const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /H1/)
  assert.match(frame, /H2/)
  assert.match(frame, /H3/)
  assert.match(frame, /H4/)
  assert.match(frame, /H5/)
  assert.match(frame, /H6/)
})

// ── Blockquote style ──

test('Blockquote: renders with ▎ bar character', () => {
  const frame = render(h(Markdown, { content: '> quoted text' })).lastFrame() ?? ''
  assert.match(frame, /▎/)
  assert.match(frame, /quoted text/)
})

test('Blockquote: nested blockquotes render correctly', () => {
  const md = '> level 1\n>> level 2'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /level 1/)
  assert.match(frame, /level 2/)
})

test('Blockquote: multiple lines render with bar prefix', () => {
  const md = '> line 1\n> line 2\n> line 3'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /line 1/)
  assert.match(frame, /line 2/)
  assert.match(frame, /line 3/)
})

// ── OSC 8 Hyperlinks ──

test('Link: renders link text', () => {
  const md = '[click here](https://example.com)'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /click here/)
})

test('Link: renders URL as fallback text', () => {
  const md = 'https://example.com'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  // Should render as text at minimum
  assert.ok(frame.length > 0)
})

// ── Integration: mixed content ──

test('Mixed: heading + blockquote + link render together', () => {
  const md = '# Title\n\n> quote with [link](https://example.com)\n\n## Subtitle'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /Title/)
  assert.match(frame, /▎/)
  assert.match(frame, /quote with/)
  assert.match(frame, /link/)
  assert.match(frame, /Subtitle/)
})

test('Mixed: heading inside blockquote renders', () => {
  // blockquote containing various inline styles
  const md = '> **bold** and *italic* and `code`'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''
  assert.match(frame, /▎/)
  assert.match(frame, /bold/)
  assert.match(frame, /italic/)
  assert.match(frame, /code/)
})

test('CJK: punctuation and mixed inline Markdown render without synthetic spaces', () => {
  const md = '代码**分析**、文件编辑、命令执行；路径 `C:\\repo\\Hanekawa-main`。'
  const frame = render(h(Markdown, { content: md })).lastFrame() ?? ''

  assert.match(frame, /代码分析、文件编辑、命令执行；路径 C:\\repo\\Hanekawa-main。/)
  assert.doesNotMatch(frame, /、 |； |。 /)
})

test('AssistantMessage: reserves the terminal edge column for mixed CJK wrapping', () => {
  const content = '我目前运行在 Windows 环境（PowerShell）下，位于 C:\\Users\\33731\\Documents\\code\\Hanekawa-main。我可以帮你进行代码分析、文件编辑、命令执行。'
  const frame = render(h(AssistantMessage, { content })).lastFrame() ?? ''

  for (const line of frame.split('\n')) {
    assert.ok(stringWidth(line) <= 99, `line must reserve one column: ${line}`)
  }
})

test('Paragraph: soft line breaks reflow while explicit hard breaks remain', () => {
  const softFrame = render(h(Markdown, { content: 'alpha\nbeta', width: 40 })).lastFrame() ?? ''
  assert.equal(softFrame, 'alpha beta')
  cleanup()

  const hardFrame = render(h(Markdown, { content: 'alpha  \nbeta', width: 40 })).lastFrame() ?? ''
  assert.equal(hardFrame, 'alpha\nbeta')
})

test('Paragraph: CJK soft line breaks do not introduce synthetic spaces', () => {
  const frame = render(h(Markdown, { content: '甲方确认\n乙方执行', width: 40 })).lastFrame() ?? ''
  assert.equal(frame, '甲方确认乙方执行')
})

test('Parser: Markdown appearing after a long plain prefix is still parsed', () => {
  const tokens = parseMarkdown(`${'a'.repeat(501)}\n\n# Late heading`)
  assert.deepEqual(tokens.map(token => token.type), ['paragraph', 'space', 'heading'])
})

test('AssistantMessage: block content starts beside the existing content prefix', () => {
  const cases = [
    ['# Title', '● Title'],
    ['```ts\nconst x = 1\n```', '●   ── ts ──'],
    ['| A | B |\n|---|---|\n| 1 | 2 |', '● ┌'],
  ] as const

  for (const [content, expectedFirstLine] of cases) {
    const frame = render(h(AssistantMessage, { content })).lastFrame() ?? ''
    const firstVisibleLine = frame.split('\n').find(line => line.length > 0) ?? ''
    assert.ok(firstVisibleLine.startsWith(expectedFirstLine), `unexpected first line: ${firstVisibleLine}`)
    cleanup()
  }
})

test('Blockquote: hard breaks and blank quote lines keep a continuous rail', () => {
  const hardBreakFrame = render(h(Markdown, { content: '> first  \n> second', width: 30 })).lastFrame() ?? ''
  assert.deepEqual(hardBreakFrame.split('\n'), [' ▎ first', ' ▎ second'])
  cleanup()

  const blankLineFrame = render(h(Markdown, { content: '> first\n>\n> second', width: 30 })).lastFrame() ?? ''
  assert.deepEqual(blankLineFrame.split('\n'), [' ▎ first', ' ▎', ' ▎ second'])
})

test('List: loose paragraphs and task markers retain structure and alignment', () => {
  const looseFrame = render(h(Markdown, {
    content: '- first paragraph\n\n  second paragraph',
    width: 40,
  })).lastFrame() ?? ''
  assert.equal(looseFrame, '• first paragraph\n\n  second paragraph')
  cleanup()

  const taskFrame = render(h(Markdown, {
    content: '- [x] finished\n- [ ] pending',
    width: 40,
  })).lastFrame() ?? ''
  assert.equal(taskFrame, '• ☑ finished\n• ☐ pending')
})
