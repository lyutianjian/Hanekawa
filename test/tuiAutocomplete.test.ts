import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { Box, Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { registerCommand } from '../src/commands/index.js'
import { useKeyboardShortcuts } from '../src/tui/hooks/useKeyboardShortcuts.js'

afterEach(() => cleanup())

function registerTestCommand(name: string): void {
  registerCommand({
    name,
    description: `${name} command`,
    run: async () => {},
  })
}

function AutocompleteHarness({ submissions }: { submissions: string[] }) {
  const state = useKeyboardShortcuts({
    onSubmit: (text) => submissions.push(text),
    onInterrupt: () => {},
    onExit: () => {},
    onEnterRestoreMode: () => {},
    onCyclePermissionMode: () => {},
    isStreaming: false,
    isRestoreMode: false,
    isPermissionVisible: false,
    doubleTapWindowMs: 50,
  })

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, `TEXT:${JSON.stringify(state.text)}`),
    h(Text, null, `SELECTED:${state.selectedSuggestion}`),
    h(Text, null, `SUGGESTIONS:${state.suggestions.map((suggestion) => suggestion.displayText).join(',')}`),
  )
}

test('slash autocomplete renders suggestions and cycles with arrows', async () => {
  registerTestCommand('aaa-autocomplete-one')
  registerTestCommand('aaa-autocomplete-two')
  const submissions: string[] = []
  const instance = render(h(AutocompleteHarness, { submissions }))

  instance.stdin.write('/aaa-autocomplete-')
  await waitForInk()
  await waitForInk()

  assert.match(instance.lastFrame() ?? '', /SUGGESTIONS:\/aaa-autocomplete-one,\/aaa-autocomplete-two/)
  assert.match(instance.lastFrame() ?? '', /SELECTED:0/)

  instance.stdin.write('\u001B[B')
  await waitForInk()

  assert.match(instance.lastFrame() ?? '', /SELECTED:1/)
})

test('slash autocomplete tab completes without submitting', async () => {
  registerTestCommand('aab-autocomplete-tab')
  const submissions: string[] = []
  const instance = render(h(AutocompleteHarness, { submissions }))

  instance.stdin.write('/aab-autocomplete')
  await waitForInk()
  await waitForInk()
  instance.stdin.write('\t')
  await waitForInk()

  assert.match(instance.lastFrame() ?? '', /TEXT:"\/aab-autocomplete-tab "/)
  assert.deepEqual(submissions, [])
})

test('slash autocomplete enter submits selected command', async () => {
  registerTestCommand('aac-autocomplete-enter')
  const submissions: string[] = []
  const instance = render(h(AutocompleteHarness, { submissions }))

  instance.stdin.write('/aac-autocomplete')
  await waitForInk()
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()

  assert.deepEqual(submissions, ['/aac-autocomplete-enter'])
  assert.match(instance.lastFrame() ?? '', /TEXT:""/)
})

test('slash autocomplete escape closes suggestions before clearing input', async () => {
  registerTestCommand('aad-autocomplete-escape')
  const submissions: string[] = []
  const instance = render(h(AutocompleteHarness, { submissions }))

  instance.stdin.write('/aad-autocomplete')
  await waitForInk()
  await waitForInk()
  assert.match(instance.lastFrame() ?? '', /SUGGESTIONS:\/aad-autocomplete-escape/)

  instance.stdin.write('\u001B')
  await waitForInk()

  assert.match(instance.lastFrame() ?? '', /TEXT:"\/aad-autocomplete"/)
  assert.match(instance.lastFrame() ?? '', /SUGGESTIONS:/)
})

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
