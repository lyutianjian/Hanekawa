import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createElement as h } from 'react'
import { Box, Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { registerCommand } from '../src/commands/index.js'
import { useKeyboardShortcuts } from '../src/tui/hooks/useKeyboardShortcuts.js'

afterEach(() => cleanup())

const execFile = promisify(execFileCallback)

function registerTestCommand(name: string): void {
  registerCommand({
    name,
    description: `${name} command`,
    run: async () => {},
  })
}

function AutocompleteHarness({ submissions, cwd }: { submissions: string[]; cwd?: string }) {
  const state = useKeyboardShortcuts({
    onSubmit: (text) => submissions.push(text),
    onInterrupt: () => {},
    onExit: () => {},
    onEnterRestoreMode: () => {},
    onCyclePermissionMode: () => {},
    isStreaming: false,
    isRestoreMode: false,
    isPermissionVisible: false,
    cwd,
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

test('file autocomplete renders @ code file suggestions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'sample.py'), 'print(1)\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@src/samp')
    await waitForFrame(instance, /SUGGESTIONS:src\/sample.py/)

    assert.match(instance.lastFrame() ?? '', /SUGGESTIONS:src\/sample.py/)
    assert.match(instance.lastFrame() ?? '', /SELECTED:0/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete root suggestions only include cwd direct children', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'root.ts'), 'export {}\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'sample.py'), 'print(1)\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@')
    await waitForFrame(instance, /SUGGESTIONS:src\/,root.ts/)

    const frame = instance.lastFrame() ?? ''
    assert.match(frame, /SUGGESTIONS:src\/,root.ts/)
    assert.doesNotMatch(frame, /src\/sample.py/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete hides gitignored cwd children', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await execFile('git', ['init'], { cwd: dir })
    await mkdir(path.join(dir, 'dist'))
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, '.gitignore'), 'dist/\n', 'utf8')
    await writeFile(path.join(dir, 'dist', 'cli.js'), 'export {}\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'agent.ts'), 'export {}\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@')
    await waitForFrame(instance, /SUGGESTIONS:src\//)

    const frame = instance.lastFrame() ?? ''
    assert.match(frame, /SUGGESTIONS:src\//)
    assert.doesNotMatch(frame, /dist/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete tab completes @ path without submitting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'sample.ts'), 'export {}\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@src/sample')
    await waitForFrame(instance, /SUGGESTIONS:src\/sample.ts/)
    instance.stdin.write('\t')
    await waitForInk()

    assert.match(instance.lastFrame() ?? '', /TEXT:"@src\/sample.ts "/)
    assert.deepEqual(submissions, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete quotes paths with spaces', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'two words.cpp'), 'int main() {}\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@src/words')
    await waitForFrame(instance, /SUGGESTIONS:src\/two words.cpp/)
    instance.stdin.write('\t')
    await waitForInk()

    assert.match(instance.lastFrame() ?? '', /TEXT:"@\\"src\/two words.cpp\\" "/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete completes directories with slash and keeps suggestions open for the next segment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'nested.py'), 'print(1)\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@sr')
    await waitForFrame(instance, /SUGGESTIONS:src\//)
    instance.stdin.write('\t')
    await waitForInk()

    assert.match(instance.lastFrame() ?? '', /TEXT:"@src\/"/)
    assert.deepEqual(submissions, [])

    instance.stdin.write('nest')
    await waitForFrame(instance, /SUGGESTIONS:src\/nested.py/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file autocomplete scopes matching inside the typed directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await mkdir(path.join(dir, 'target'))
    await mkdir(path.join(dir, 'test'))
    await writeFile(path.join(dir, 'target', 'bundle.js'), 'export {}\n', 'utf8')
    await writeFile(path.join(dir, 'test', 'targetLike.test.ts'), 'test("x", () => {})\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('@target/')
    await waitForFrame(instance, /SUGGESTIONS:target\/bundle.js/)

    const frame = instance.lastFrame() ?? ''
    assert.match(frame, /SUGGESTIONS:target\/bundle.js/)
    assert.doesNotMatch(frame, /test\/targetLike.test.ts/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('slash autocomplete remains higher priority than file autocomplete', async () => {
  registerTestCommand('aae-priority')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-file-ac-'))
  try {
    await writeFile(path.join(dir, 'aae-priority.py'), 'print(1)\n', 'utf8')
    const submissions: string[] = []
    const instance = render(h(AutocompleteHarness, { submissions, cwd: dir }))

    instance.stdin.write('/aae-priority')
    await waitForInk()
    await waitForInk()

    assert.match(instance.lastFrame() ?? '', /SUGGESTIONS:\/aae-priority/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitForFrame(instance: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await waitForInk()
    if (pattern.test(instance.lastFrame() ?? '')) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
