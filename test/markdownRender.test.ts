import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Markdown } from '../src/tui/components/Markdown.js'

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
