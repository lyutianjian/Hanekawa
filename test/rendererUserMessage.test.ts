import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { splitFileMentions } from '../src/desktop/renderer/model/userMessage.js'
import { extractAtMentions } from '../src/runtime/suggestions/atToken.js'

/**
 * The user bubble's segmentation. The property at the bottom is the one that makes
 * 「正文逐字不变」 checkable rather than a claim in a comment.
 */

const rebuilt = (input: string): string => splitFileMentions(input).map((segment) => segment.text).join('')
const labels = (input: string): string[] =>
  splitFileMentions(input).flatMap((segment) => (segment.kind === 'file' ? [segment.label] : []))

test('a message with no mention is one text segment', () => {
  assert.deepEqual(splitFileMentions('hello there'), [{ kind: 'text', text: 'hello there' }])
  assert.deepEqual(splitFileMentions(''), [])
})

test('a bare mention becomes a pill and the text around it is untouched', () => {
  assert.deepEqual(splitFileMentions('look at @src/a.ts please'), [
    { kind: 'text', text: 'look at ' },
    { kind: 'file', text: '@src/a.ts', label: 'src/a.ts' },
    { kind: 'text', text: ' please' },
  ])
})

test('a mention at the very start needs no leading text segment', () => {
  assert.deepEqual(splitFileMentions('@a.ts is broken'), [
    { kind: 'file', text: '@a.ts', label: 'a.ts' },
    { kind: 'text', text: ' is broken' },
  ])
})

test('the quoted form keeps its spaces and loses only the punctuation', () => {
  assert.deepEqual(splitFileMentions('read @"src/with space.cpp"#L3-4 now'), [
    { kind: 'text', text: 'read ' },
    { kind: 'file', text: '@"src/with space.cpp"#L3-4', label: 'src/with space.cpp#L3-4' },
    { kind: 'text', text: ' now' },
  ])
})

test('a line range rides along in the label', () => {
  assert.deepEqual(labels('see @src/a.ts#L10-20'), ['src/a.ts#L10-20'])
})

test('two mentions in one sentence both become pills', () => {
  assert.deepEqual(splitFileMentions('把 @a.ts 的逻辑搬到 @b.ts'), [
    { kind: 'text', text: '把 ' },
    { kind: 'file', text: '@a.ts', label: 'a.ts' },
    { kind: 'text', text: ' 的逻辑搬到 ' },
    { kind: 'file', text: '@b.ts', label: 'b.ts' },
  ])
})

test('an address is not a mention, because a mention starts at a word boundary', () => {
  // The `(^|\s)` group earns its keep here: without it every email in a pasted
  // stack trace turns into a file pill.
  assert.deepEqual(labels('mail me at foo@bar.com'), [])
  assert.equal(rebuilt('mail me at foo@bar.com'), 'mail me at foo@bar.com')
})

test('mentions are reported in reading order, not pattern order', () => {
  // The quoted pattern runs first, so an unsorted implementation reports the later
  // quoted mention before the earlier bare one — and the bubble is reassembled with
  // its words swapped.
  assert.deepEqual(labels('@a.ts then @"b c.ts"'), ['a.ts', 'b c.ts'])
  assert.equal(rebuilt('@a.ts then @"b c.ts"'), '@a.ts then @"b c.ts"')
})

test('the spans a chip is built from point at exactly the text it replaces', () => {
  const input = 'read @"a b.ts"#L2 and @c.ts'
  for (const span of extractAtMentions(input)) {
    assert.equal(input.slice(span.start, span.end), span.text)
  }
})

test('every segmentation reassembles into the input, character for character', () => {
  // The decision「原地内联，正文不变」, as a property. A segmenter that hoisted a
  // mention out of the body — the design document's own layout — fails this.
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z@". \n#L0-9一-龥/-]*$/),
      (input) => {
        assert.equal(rebuilt(input), input)
      },
    ),
    { numRuns: 500 },
  )
})
