import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { CommandViewPanel } from '../src/tui/components/CommandViewPanel.js'
import { commandVisibleRows, getVisibleWindow } from '../src/tui/components/CommandUI.js'

afterEach(() => cleanup())

test('command list viewport follows focus and exposes overflow state', () => {
  assert.deepEqual(getVisibleWindow(20, 10, 6), {
    start: 7,
    end: 13,
    hasAbove: true,
    hasBelow: true,
  })
  assert.deepEqual(getVisibleWindow(2, 99, 6), {
    start: 0,
    end: 2,
    hasAbove: false,
    hasBelow: false,
  })
  assert.equal(commandVisibleRows(12, 9, 10), 3)
})

test('structured command views share title, hierarchy, and input guide', () => {
  const frame = render(h(CommandViewPanel, {
    view: {
      kind: 'info',
      title: 'Session usage',
      subtitle: 'Token consumption and cache health',
      sections: [{ title: 'Usage', rows: [{ label: 'Input tokens', value: '1,024' }] }],
    },
    onClose: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /Session usage/)
  assert.match(frame, /Token consumption and cache health/)
  assert.match(frame, /Usage/)
  assert.match(frame, /Input tokens\s+1,024/)
  assert.match(frame, /Esc to close/)
})

test('structured list views use the shared focused-row marker', () => {
  const frame = render(h(CommandViewPanel, {
    view: {
      kind: 'list',
      title: 'Help',
      items: [
        { id: 'help', label: '/help', description: 'Show available commands' },
        { id: 'model', label: '/model', description: 'Select a model' },
      ],
    },
    onClose: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /❯ \/help/)
  assert.match(frame, /Show available commands/)
  assert.match(frame, /↑\/↓ to navigate/)
})
