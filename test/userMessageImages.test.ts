import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { UserMessage, imageAttachmentLine } from '../src/tui/components/UserMessage.js'
import { MessageList } from '../src/tui/components/MessageList.js'
import { recordsToDisplayItems } from '../src/tui/transcript.js'
import { attachmentSendVersionPath } from '../src/services/imageAttachments/imageAttachmentService.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import type { QueuedMessage } from '../src/runtime/messageQueue.js'

afterEach(() => cleanup())

// A fixed fake project root keeps the rendered path assertions stable.
const CWD = process.platform === 'win32' ? 'C:\\project' : '/project'

const ref: ImageAttachmentRef = makeImageAttachmentRef({
  id: 'img-abc',
  ownerSessionId: 'session-1',
  name: 'screenshot.png',
  width: 1920,
  height: 1080,
})

test('the attachment line links the send version on OSC 8 terminals', () => {
  const line = imageAttachmentLine(1, ref, { cwd: CWD, hyperlinks: true })
  const sendPath = attachmentSendVersionPath(CWD, ref)

  assert.ok(line.includes('[图片 1：screenshot.png，1920×1080]'))
  assert.match(line, /\x1b\]8;;file:/)
  assert.ok(line.includes('image.png'))
  // Hyperlink terminals get the link, not the path spelled out as text — which
  // is a claim about what the terminal *prints*, so it is asserted against the
  // visible half. The whole line would not do: a POSIX `file://` URL contains
  // its own path verbatim, so the substring is there either way.
  assert.ok(!visibleText(line).includes(sendPath))
})

test('the attachment line spells out the copyable path without OSC 8', () => {
  const line = imageAttachmentLine(2, ref, { cwd: CWD, hyperlinks: false })
  assert.equal(line, `[图片 2：screenshot.png，1920×1080] ${attachmentSendVersionPath(CWD, ref)}`)
  assert.ok(!line.includes('\x1b'))
})

test('a user message with images renders numbered attachment lines with copyable paths', () => {
  const frame = render(h(UserMessage, {
    content: 'what is in this picture',
    images: [ref],
    cwd: CWD,
    hyperlinks: false,
  })).lastFrame() ?? ''

  assert.match(frame, /what is in this picture/)
  assert.match(frame, /\[图片 1：screenshot\.png，1920×1080\]/)
  assert.match(frame, new RegExp(escapeRegExp(attachmentSendVersionPath(CWD, ref))))
})

test('a pure-image message gets a text fallback title', () => {
  const frame = render(h(UserMessage, {
    content: '',
    images: [ref, makeImageAttachmentRef({ id: 'img-2', name: 'second.png' })],
    cwd: CWD,
    hyperlinks: false,
  })).lastFrame() ?? ''

  assert.match(frame, /图片：screenshot\.png（共 2 张）/)
  assert.match(frame, /\[图片 2：second\.png，64×64\]/)
})

test('recordsToDisplayItems carries user message images into the display item', () => {
  const items = recordsToDisplayItems([
    {
      id: 'msg-1',
      type: 'message',
      role: 'user',
      content: 'look',
      images: [ref],
      createdAt: '2026-09-08T00:00:00.000Z',
    },
  ])
  const userItem = items.find((item) => item.kind === 'user')
  assert.ok(userItem && userItem.kind === 'user')
  assert.deepEqual(userItem.images, [ref])

  // A message without images keeps the field absent, matching old records.
  const textOnly = recordsToDisplayItems([
    { id: 'msg-2', type: 'message', role: 'user', content: 'hi', createdAt: '2026-09-08T00:00:00.000Z' },
  ])
  const textItem = textOnly.find((item) => item.kind === 'user')
  assert.ok(textItem && textItem.kind === 'user')
  assert.equal('images' in textItem, false)
})

test('queued messages show the image count and a pure-image fallback title', () => {
  const queued: QueuedMessage[] = [
    {
      id: 'q-1',
      content: 'and this one',
      images: [ref, makeImageAttachmentRef({ id: 'img-2', name: 'second.png' })],
      priority: 'next',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
    {
      id: 'q-2',
      content: '',
      images: [ref],
      priority: 'next',
      createdAt: '2026-09-08T00:00:01.000Z',
    },
    {
      id: 'q-3',
      content: 'text only',
      priority: 'next',
      createdAt: '2026-09-08T00:00:02.000Z',
    },
  ]
  const frame = render(h(MessageList, { items: [], queuedMessages: queued })).lastFrame() ?? ''

  assert.match(frame, /❯ and this one \(\+2 images\) \(queued\)/)
  assert.match(frame, /❯ 图片：screenshot\.png \(\+1 image\) \(queued\)/)
  assert.match(frame, /❯ text only \(queued\)/)
})

/**
 * What an OSC 8 line actually shows: the label between the two hyperlink
 * introducers, with the URLs (and every other escape) taken out.
 */
function visibleText(line: string): string {
  return line.replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
