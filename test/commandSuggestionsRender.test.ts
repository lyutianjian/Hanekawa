import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { CommandSuggestions } from '../src/tui/components/CommandSuggestions.js'
import type { CommandSuggestion } from '../src/runtime/suggestions/commandSuggestions.js'

afterEach(() => cleanup())

test('CommandSuggestions scrolls the visible window around the selected row without arrow markers', () => {
  const suggestions: CommandSuggestion[] = Array.from({ length: 10 }, (_, index) => ({
    id: `cmd-${index}`,
    displayText: `/cmd-${index}`,
    description: `Command ${index}`,
    metadata: {
      name: `cmd-${index}`,
      description: `Command ${index}`,
      run: async () => {},
    },
  }))

  const frame = render(h(CommandSuggestions, {
    suggestions,
    selectedIndex: 7,
  })).lastFrame() ?? ''

  assert.doesNotMatch(frame, /\/cmd-0/)
  assert.match(frame, /\/cmd-7/)
  assert.doesNotMatch(frame, />\s+\/cmd-/)
})
