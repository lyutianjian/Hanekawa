import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveKey, type ShellState } from '../src/desktop/renderer/model/keymap.js'
import {
  NO_COMPLETIONS,
  acceptCompletion,
  classifyInput,
  commandEffectToIntent,
  commandViewRows,
  completionsFor,
  moveCompletion,
} from '../src/desktop/renderer/model/commandRouting.js'
import {
  SUPPORTED_SURFACES,
  backgroundTasksView,
  effortPickerView,
  isSupportedSurface,
  modelPickerView,
  resumePickerView,
} from '../src/desktop/renderer/model/surfaces.js'
import type { CommandSurface, WireCommandInfo, WireModelsResult } from '../src/runtime/protocol/wire.js'

/**
 * The keyboard, the composer's routing, and the four pickers.
 *
 * The first test is the one that matters most: Escape with a dialog open must
 * answer the dialog, never interrupt. Interrupting does not release a turn parked
 * on a permission prompt (`ToolRunner.run` never passes its signal into
 * `PermissionGate.approve`), so getting this backwards wedges the app.
 */

function shell(overrides: Partial<ShellState> = {}): ShellState {
  return {
    hasOverlay: false,
    hasSurface: false,
    hasCompletions: false,
    isStreaming: false,
    inputEmpty: false,
    ...overrides,
  }
}

test('Escape answers an open dialog and never interrupts, even mid-turn', () => {
  assert.equal(resolveKey({ key: 'Escape' }, shell({ hasOverlay: true, isStreaming: true })), 'overlay')
  // Everything else defers too: the dialog owns the keyboard outright.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ hasOverlay: true })), 'overlay')
  assert.equal(resolveKey({ key: 'y' }, shell({ hasOverlay: true })), 'overlay')
  assert.equal(resolveKey({ key: 'Tab' }, shell({ hasOverlay: true, hasCompletions: true })), 'overlay')
})

test('Escape interrupts only when nothing is open and a turn is running', () => {
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true })), 'interrupt')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: false })), 'none')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true, hasSurface: true })), 'close-surface')
})

test('Enter submits only when idle and non-empty; Shift+Enter is a newline', () => {
  assert.equal(resolveKey({ key: 'Enter' }, shell()), 'submit')
  assert.equal(resolveKey({ key: 'Enter', shiftKey: true }, shell()), 'newline')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ inputEmpty: true })), 'none')
  // A second turn would overwrite the controller's AbortController and leave the
  // first one impossible to interrupt.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ isStreaming: true })), 'none')
})

test('the completion dropdown owns Tab, the arrows and Enter while open', () => {
  const open = shell({ hasCompletions: true })
  assert.equal(resolveKey({ key: 'Tab' }, open), 'accept-completion')
  // Enter accepts *and runs*, the way `useKeyboardShortcuts.ts:286-291` submits a
  // command suggestion. Tab is the accept-only affordance.
  assert.equal(resolveKey({ key: 'Enter' }, open), 'submit-completion')
  assert.equal(resolveKey({ key: 'ArrowDown' }, open), 'move-completion-down')
  assert.equal(resolveKey({ key: 'ArrowUp' }, open), 'move-completion-up')
  assert.equal(resolveKey({ key: 'Escape' }, open), 'close-completions')
  // Shift+Enter still inserts a newline rather than accepting.
  assert.equal(resolveKey({ key: 'Enter', shiftKey: true }, open), 'newline')
  // Mid-turn there is nothing to submit into, so Enter degrades to accepting.
  assert.equal(
    resolveKey({ key: 'Enter' }, shell({ hasCompletions: true, isStreaming: true })),
    'accept-completion',
  )
})

test('a leading slash is a command, never prose', () => {
  assert.deepEqual(classifyInput('/model sonnet'), { kind: 'command', line: '/model sonnet' })
  assert.deepEqual(classifyInput('  /help  '), { kind: 'command', line: '/help' })
  assert.deepEqual(classifyInput('what is /model'), { kind: 'prompt', text: 'what is /model' })
  assert.deepEqual(classifyInput('   '), { kind: 'empty' })
})

const COMMANDS: WireCommandInfo[] = [
  { name: 'model', description: 'Switch model', aliases: ['m'] },
  { name: 'clear', description: 'Clear session' },
  { name: 'cost', description: 'Show usage' },
]

test('completions rank exact and prefix matches, and stop once args are typed', () => {
  assert.deepEqual(completionsFor('/', COMMANDS).suggestions.map((s) => s.displayText),
    ['/clear', '/cost', '/model'])

  assert.equal(completionsFor('/mo', COMMANDS).suggestions[0]?.displayText, '/model')
  assert.equal(completionsFor('/m', COMMANDS).suggestions[0]?.displayText, '/model', 'alias wins')
  assert.deepEqual(completionsFor('/model sonnet', COMMANDS), NO_COMPLETIONS)
  assert.deepEqual(completionsFor('hello', COMMANDS), NO_COMPLETIONS)
  assert.deepEqual(completionsFor('/zzz', COMMANDS), NO_COMPLETIONS)
})

test('the dropdown wraps, and accepting rewrites the composer', () => {
  const state = completionsFor('/', COMMANDS)
  assert.equal(state.selectedIndex, 0)
  assert.equal(moveCompletion(state, 'up').selectedIndex, 2, 'up from the top wraps')
  assert.equal(moveCompletion(state, 'down').selectedIndex, 1)

  assert.deepEqual(acceptCompletion(state), { text: '/clear ', cursorPos: 7 })
  assert.equal(acceptCompletion(NO_COMPLETIONS), undefined)
})

test('all three command effects map to something the view can do', () => {
  assert.deepEqual(commandEffectToIntent({ kind: 'write-line', text: 'hi' }), { kind: 'write-line', text: 'hi' })
  assert.deepEqual(commandEffectToIntent({ kind: 'open-surface', surface: 'model-picker' }),
    { kind: 'open-surface', surface: 'model-picker' })

  const view = commandEffectToIntent({
    kind: 'open-command-view',
    view: { kind: 'list', title: 'Commands', items: [{ id: 'help', label: '/help', description: 'Show help' }] },
  })
  assert.equal(view.kind, 'show-view')
  assert.ok(view.kind === 'show-view')
  assert.deepEqual(view.rows, [{ label: '/help', value: 'Show help', tone: 'normal' }])

  // A fourth effect kind must be a compile error, not a silent drop.
  assert.throws(() => commandEffectToIntent({ kind: 'invented' } as never), /Unhandled command effect/)
})

test('an info view flattens sections into headed rows with their tones', () => {
  const rows = commandViewRows({
    kind: 'info',
    title: 'Cost',
    sections: [
      { title: 'Tokens', rows: [{ label: 'in', value: '10' }, { label: 'out', value: '5', tone: 'success' }] },
      { rows: [{ label: 'errors', value: '1', tone: 'error' }] },
    ],
  })

  assert.deepEqual(rows, [
    { label: 'Tokens', value: '', tone: 'normal', heading: true },
    { label: 'in', value: '10', tone: 'normal' },
    { label: 'out', value: '5', tone: 'success' },
    { label: 'errors', value: '1', tone: 'error' },
  ])
})

test('the model picker marks the current tier and explains a disabled one', () => {
  const result: WireModelsResult = {
    models: [],
    defaultModelKey: 'sonnet',
    pickerOptions: [
      { tier: 'fast', label: 'Fast', modelKey: 'haiku', modelId: 'claude-haiku', providerName: 'anthropic', isCurrent: false, isDefault: false },
      { tier: 'balanced', label: 'Balanced', modelKey: 'sonnet', modelId: 'claude-sonnet', providerName: 'anthropic', isCurrent: true, isDefault: true },
      { tier: 'powerful', label: 'Powerful', disabledReason: 'no model configured', isCurrent: false, isDefault: false },
    ],
  }

  const view = modelPickerView(result)

  assert.deepEqual(view.rows.map((row) => row.id), ['fast', 'balanced', 'powerful'])
  assert.equal(view.rows[1]?.current, true)
  assert.match(view.rows[1]?.detail ?? '', /default/)
  assert.equal(view.rows[2]?.disabled, true)
  assert.equal(view.rows[2]?.disabledReason, 'no model configured')

  // Parity with the host test: nothing derived from a ModelConfig may leak a key.
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(serialized.includes('baseUrl'), false)
})

test('the effort picker shows levels above the model ceiling as unavailable', () => {
  const view = effortPickerView({ current: 'high', maxEffort: 'high', configured: 'max' })

  assert.deepEqual(view.rows.map((row) => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(view.rows.find((row) => row.id === 'high')?.current, true)
  assert.equal(view.rows.find((row) => row.id === 'xhigh')?.disabled, true)
  assert.match(view.rows.find((row) => row.id === 'max')?.disabledReason ?? '', /above this model's maximum/)
  // A configured level the active model cannot honour is still visible.
  assert.equal(view.rows.find((row) => row.id === 'max')?.detail, 'configured')

  const unclamped = effortPickerView({ current: 'low' })
  assert.equal(unclamped.rows.some((row) => row.disabled), false)
})

test('background tasks and sessions render with their status and counts', () => {
  const tasks = backgroundTasksView([
    { id: 't1', sessionId: 's', kind: 'shell', status: 'running', command: 'npm test', startedAt: 0, outputBytes: 10, unreadBytes: 4 },
    { id: 't2', sessionId: 's', kind: 'agent', status: 'completed', agentType: 'explore', description: 'find it', startedAt: 0, exitCode: 0, outputBytes: 0, unreadBytes: 0 },
  ])
  assert.equal(tasks.rows[0]?.label, 'npm test')
  assert.match(tasks.rows[0]?.detail ?? '', /running · 4 new bytes/)
  assert.equal(tasks.rows[1]?.label, 'explore: find it')
  assert.match(tasks.rows[1]?.detail ?? '', /completed · exit 0/)
  assert.equal(backgroundTasksView([]).rows.length, 0)
  assert.equal(backgroundTasksView([]).emptyMessage, 'No background tasks.')

  const sessions = resumePickerView({
    sessions: [
      { id: 'a', shortId: 'a1', createdAt: 'x', updatedAt: 'y', title: 'First', messageCount: 1 },
      { id: 'b', shortId: 'b2', createdAt: 'x', updatedAt: 'y', messageCount: 4 },
    ],
    currentSessionId: 'a',
  })
  assert.equal(sessions.rows[0]?.current, true)
  assert.match(sessions.rows[0]?.detail ?? '', /1 message /)
  assert.equal(sessions.rows[1]?.label, 'b2', 'an untitled session falls back to its short id')
  assert.match(sessions.rows[1]?.detail ?? '', /4 messages/)
})

test('the provider panel is the one surface this shell does not draw', () => {
  // Typed as `CommandSurface` because `isSupportedSurface` is a predicate that
  // narrows *away* from this value — passing the literal would not compile.
  const providerPanel: CommandSurface = 'provider-panel'
  assert.equal(isSupportedSurface(providerPanel), false)
  assert.equal((SUPPORTED_SURFACES as readonly CommandSurface[]).includes(providerPanel), false)
  for (const surface of ['model-picker', 'effort-picker', 'background-tasks', 'resume-picker'] as const) {
    assert.equal(isSupportedSurface(surface), true)
  }
})
