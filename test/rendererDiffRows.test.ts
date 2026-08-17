import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFF_CONTEXT_LINES,
  diffRowsFor,
  droppedLines,
  previewView,
} from '../src/desktop/renderer/model/diffRows.js'
import { buildFileToolPreview, capFileToolPreview } from '../src/services/fileToolPreview.js'
import type { FileToolPreview } from '../src/services/fileToolPreview.js'

/**
 * The desktop permission dialog's diff, over the previews the host actually
 * sends. Built against `buildFileToolPreview` rather than hand-written fixtures
 * so a change to the host-side shape shows up here instead of drifting.
 */

// `assertInsideCwd` resolves against a real path, so this has to be the real
// cwd rather than a fixture root; the readFile stub keeps the filesystem out.
const cwd = process.cwd()

function preview(toolName: string, input: unknown, files: Record<string, string>): FileToolPreview {
  const built = buildFileToolPreview(toolName, input, {
    cwd,
    readFile: (absolutePath) => {
      const key = absolutePath.replace(/\\/g, '/')
      for (const [name, content] of Object.entries(files)) {
        if (key.endsWith(name)) return content
      }
      return undefined
    },
  })
  assert.ok(built, 'expected a preview')
  return built
}

test('creating a file is all additions, numbered from one', () => {
  const view = previewView(preview('Write', { filePath: 'new.txt', content: 'a\nb\n' }, {}))

  assert.equal(view.kind, 'diff')
  assert.ok(view.kind === 'diff')
  assert.deepEqual(view.rows.map((row) => [row.kind, row.text]), [['add', 'a'], ['add', 'b']])
  assert.deepEqual(view.rows.map((row) => row.newLine), [1, 2])
  assert.deepEqual(view.rows.map((row) => row.oldLine), [undefined, undefined])
})

test('an edit shows removals, additions and bounded context', () => {
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  const view = previewView(preview(
    'Edit',
    { filePath: 'a.txt', oldString: 'line 15', newString: 'LINE 15' },
    { 'a.txt': original },
  ))

  assert.ok(view.kind === 'diff')
  const kinds = view.rows.map((row) => row.kind)
  assert.ok(kinds.includes('del'), 'the old line is shown')
  assert.ok(kinds.includes('add'), 'the new line is shown')
  assert.ok(kinds.includes('elided'), '30 lines of context are collapsed')

  const del = view.rows.find((row) => row.kind === 'del')
  const add = view.rows.find((row) => row.kind === 'add')
  assert.equal(del?.text, 'line 15')
  assert.equal(add?.text, 'LINE 15')

  // Context is capped either side of the change rather than shown whole; a
  // one-line edit in a long file must not render as 30 unchanged rows.
  const contextRows = view.rows.filter((row) => row.kind === 'ctx')
  assert.ok(contextRows.length <= DIFF_CONTEXT_LINES * 2, `got ${contextRows.length} context rows`)
})

test('a delete shows every line as a removal', () => {
  const view = previewView(preview('Delete', { filePath: 'gone.txt' }, { 'gone.txt': 'x\ny\n' }))

  assert.ok(view.kind === 'diff')
  assert.deepEqual(view.rows.map((row) => row.kind), ['del', 'del'])
  assert.deepEqual(view.rows.map((row) => row.oldLine), [1, 2])
})

test('overwriting an existing file diffs against its current contents', () => {
  const view = previewView(preview(
    'Write',
    { filePath: 'a.txt', content: 'one\nTWO\n' },
    { 'a.txt': 'one\ntwo\n' },
  ))

  assert.ok(view.kind === 'diff')
  assert.deepEqual(
    view.rows.filter((row) => row.kind !== 'ctx').map((row) => [row.kind, row.text]),
    [['del', 'two'], ['add', 'TWO']],
  )
})

test('the host\'s elided count is reported as the larger side, not the sum', () => {
  assert.equal(droppedLines({ oldLines: 300, newLines: 290 }), 300)

  const big = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
  const capped = capFileToolPreview(preview(
    'Write',
    { filePath: 'big.txt', content: Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n') },
    { 'big.txt': big },
  ))
  assert.ok(capped)
  assert.ok(capped.kind === 'diff' && capped.elided, 'the host capped this preview')

  const view = previewView(capped)
  assert.ok(view.kind === 'diff')
  const last = view.rows.at(-1)
  assert.equal(last?.kind, 'elided')
  assert.match(last?.text ?? '', /more lines?$/)
  // Summary tells the same truth, so a user reading either number is not misled.
  assert.match(view.summary, /more lines not shown/)
})

test('a message preview is passed through, not rendered as an empty diff', () => {
  const view = previewView({
    kind: 'message',
    title: 'Write preview unavailable',
    filePath: 'x.txt',
    message: 'File is too large to preview.',
  })

  assert.equal(view.kind, 'message')
  assert.ok(view.kind === 'message')
  assert.equal(view.message, 'File is too large to preview.')
  assert.equal(view.filePath, 'x.txt')
})

test('rows are capped for display, with the overflow named', () => {
  const rows = diffRowsFor('', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
  assert.equal(rows.length, 50)

  const view = previewView(
    { kind: 'diff', title: 't', filePath: 'f', oldText: '', newText: rows.map((r) => r.text).join('\n'), summary: '+50' },
    { maxRows: 10 },
  )
  assert.ok(view.kind === 'diff')
  assert.equal(view.rows.length, 11)
  assert.equal(view.rows.at(-1)?.kind, 'elided')
  assert.equal(view.rows.at(-1)?.text, '… 40 more lines')
})

test('text ending in a newline does not produce a phantom trailing row', () => {
  assert.deepEqual(diffRowsFor('', 'a\n').map((row) => row.text), ['a'])
  assert.deepEqual(diffRowsFor('', 'a\n\n').map((row) => row.text), ['a', ''])
})
