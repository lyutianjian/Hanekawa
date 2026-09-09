import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUEUED_LABEL_MAX_CHARS,
  queuedMessagesView,
} from '../src/desktop/renderer/model/queuedMessages.js'
import type { PersistedQueuedMessage } from '../src/harness/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

/**
 * The queued-message strip's decisions, with the DOM left out.
 *
 * The strip is what makes the desktop's mid-turn Enter honest: the message is no
 * longer dropped, it goes to the host's queue, and the user has to be able to see
 * that. Everything here is `model/` rather than `dom/` for the usual reason — this
 * file compiles in the base tsconfig program, which has no DOM lib.
 */

function message(overrides: Partial<PersistedQueuedMessage> = {}): PersistedQueuedMessage {
  return {
    id: 'm1',
    content: 'hello',
    priority: 'next',
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  }
}

test('an empty queue has no title, which is how the strip stays hidden', () => {
  const view = queuedMessagesView([])
  assert.deepEqual(view.rows, [])
  assert.equal(view.title, undefined)
})

test('rows are numbered from one, in queue order', () => {
  const view = queuedMessagesView([
    message({ id: 'a', content: 'first' }),
    message({ id: 'b', content: 'second' }),
  ])

  assert.deepEqual(view.rows.map((row) => [row.position, row.id, row.label]), [
    [1, 'a', 'first'],
    [2, 'b', 'second'],
  ])
  assert.match(view.title ?? '', /已排队 2 条/)
  // The title has to say *why* they are waiting; "Queued (2)" alone reads like an
  // error state rather than a turn that is still running.
  assert.match(view.title ?? '', /当前轮次结束后发送/)
})

test('the count in the title tracks the rows', () => {
  assert.match(queuedMessagesView([message()]).title ?? '', /已排队 1 条/)
})

test('a queued message says how many images ride with it', () => {
  const view = queuedMessagesView([message({
    content: 'compare these',
    images: [
      makeImageAttachmentRef({ id: 'i1', ownerSessionId: 's', name: 'a.png' }),
      makeImageAttachmentRef({ id: 'i2', ownerSessionId: 's', name: 'b.png' }),
    ],
  })])
  assert.equal(view.rows[0]?.label, 'compare these · 2 张图片')
})

test('an image-only queued message is named by its files, not left blank', () => {
  // Text-less image messages are legal input (S06); a blank row would make one
  // look like an empty message the user could not identify or clear on purpose.
  const view = queuedMessagesView([message({
    content: '',
    images: [makeImageAttachmentRef({ id: 'i1', ownerSessionId: 's', name: 'shot.png' })],
  })])
  assert.equal(view.rows[0]?.label, '图片：shot.png')
})

test('an image-only label is bounded like any other', () => {
  const view = queuedMessagesView([message({
    content: '   ',
    images: Array.from({ length: 20 }, (_, index) => makeImageAttachmentRef({
      id: `i${index}`,
      ownerSessionId: 's',
      name: `attachment-with-a-long-name-${index}.png`,
    })),
  })])
  assert.ok((view.rows[0]?.label.length ?? 0) <= QUEUED_LABEL_MAX_CHARS + 1)
})

test('a multi-line message collapses to one line', () => {
  // One row per message, so a pasted prompt must not take over the window.
  const view = queuedMessagesView([message({ content: 'first line\n\nsecond line\tthird' })])
  assert.equal(view.rows[0]?.label, 'first line second line third')
})

test('a long message is truncated with an ellipsis', () => {
  const view = queuedMessagesView([message({ content: 'x'.repeat(QUEUED_LABEL_MAX_CHARS + 50) })])
  const label = view.rows[0]?.label ?? ''

  assert.equal(label.length, QUEUED_LABEL_MAX_CHARS + 1, 'the ellipsis is one character')
  assert.ok(label.endsWith('…'))
})

test('a message exactly at the limit keeps every character', () => {
  const content = 'y'.repeat(QUEUED_LABEL_MAX_CHARS)
  const view = queuedMessagesView([message({ content })])

  assert.equal(view.rows[0]?.label, content)
  assert.equal(view.rows[0]?.label.endsWith('…'), false)
})

test('truncation never leaves a space before the ellipsis', () => {
  // `${slice}…` on a slice that happens to end mid-gap would read as "word …".
  const content = `${'z'.repeat(QUEUED_LABEL_MAX_CHARS - 1)} tail end`
  const label = queuedMessagesView([message({ content })]).rows[0]?.label ?? ''

  assert.ok(label.endsWith('z…'), `expected no gap before the ellipsis, got ${JSON.stringify(label.slice(-4))}`)
})

test('surrounding whitespace is dropped rather than rendered', () => {
  assert.equal(queuedMessagesView([message({ content: '   padded   ' })]).rows[0]?.label, 'padded')
})
