import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySettingsIntent,
  createSettingsState,
  draftToChange,
  draftToChanges,
  loadSettings,
  routingOptions,
  runSettingsChanges,
  settingsChordToIntent,
  settingsKeyToIntent,
  settingsView,
  type SettingsClient,
  type SettingsDraft,
  type SettingsState,
} from '../src/desktop/renderer/model/settings.js'
import type {
  SettingsChange,
  WireSettingsSnapshot,
  WireShellSettingsChangeResult,
  WireShellSettingsResult,
} from '../src/desktop/shellProtocol.js'

/**
 * The settings screen's decisions, all of which live in `model/settings.ts`.
 *
 * The DOM half (`dom/settingsView.ts`) is deliberately uncovered — there is no
 * jsdom in this runner, which is exactly why every decision is a pure function
 * here rather than a branch inside a view.
 *
 * The load-bearing case in this file is the API-key one. The key field is
 * seeded from a *masked* value, so anything that sends it unconditionally
 * writes `sk-a...ijkl` into the user's config as though it were the key.
 */

function snapshotOf(overrides: Partial<WireSettingsSnapshot> = {}): WireSettingsSnapshot {
  return {
    projectRoot: 'C:\\repo\\alpha',
    projectName: 'alpha',
    saveTarget: 'C:\\repo\\alpha\\.myagent\\config.json',
    endpoints: [
      { name: 'main', provider: 'anthropic', baseUrl: 'https://api.example', apiKeyMasked: 'sk-a...ijkl' },
    ],
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', contextWindow: 200_000, resolves: true },
      { key: 'broken', model: 'gone', endpoint: 'missing', resolves: false },
    ],
    routing: {
      main: 'big',
      plan: 'inherit',
      compact: 'inherit',
      subagent: [
        { type: 'general', value: 'inherit' },
        { type: 'explore', value: 'big' },
      ],
    },
    defaultModel: 'big',
    providers: ['anthropic', 'openai'],
    subagentTypes: ['general', 'explore'],
    ...overrides,
  }
}

function openState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    ...createSettingsState(),
    open: true,
    projectRoot: 'C:\\repo\\alpha',
    snapshot: snapshotOf(),
    projects: [{ projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' }],
    ...overrides,
  }
}

// --- the api key rule --------------------------------------------------------

test('an untouched key field is omitted from the change, never sent as its mask', () => {
  const state = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const draft = state.draft
  assert.ok(draft && draft.kind === 'endpoint')
  assert.equal(draft.keyTouched, false)

  // The user changes the base URL only.
  const edited = applySettingsIntent(state, {
    kind: 'draft-field',
    field: 'baseUrl',
    value: 'https://api.changed',
  }).state
  assert.ok(edited.draft)

  const change = draftToChange(edited.draft, snapshotOf())
  assert.ok(!('error' in change))
  assert.equal('apiKey' in change, false, 'an untouched key must not reach the wire at all')
  assert.deepEqual(change, {
    scope: 'provider',
    kind: 'set-endpoint',
    name: 'main',
    provider: 'anthropic',
    baseUrl: 'https://api.changed',
  })
})

test('typing in the key field is the only thing that arms it', () => {
  const opened = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const typed = applySettingsIntent(opened, {
    kind: 'draft-field',
    field: 'apiKey',
    value: 'sk-brand-new-key',
  }).state
  assert.ok(typed.draft && typed.draft.kind === 'endpoint')
  assert.equal(typed.draft.keyTouched, true)

  const change = draftToChange(typed.draft, snapshotOf())
  assert.ok(!('error' in change))
  assert.equal((change as Extract<SettingsChange, { kind: 'set-endpoint' }>).apiKey, 'sk-brand-new-key')
})

test('an edited endpoint seeds its key field empty, not with the mask', () => {
  const state = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  assert.ok(state.draft && state.draft.kind === 'endpoint')
  assert.equal(state.draft.apiKey, '', 'the mask must never become the field value')
})

// --- routing options ---------------------------------------------------------

test('routing options put inherit first and keep unresolvable keys, labelled', () => {
  const options = routingOptions(snapshotOf())
  assert.equal(options[0]?.value, 'inherit')
  const broken = options.find((option) => option.value === 'broken')
  assert.ok(broken, 'a configured model that cannot resolve must still be selectable')
  assert.match(broken.label, /无法解析/)
  assert.equal(options.find((option) => option.value === 'big')?.label, 'big')
})

// --- keys --------------------------------------------------------------------

test('the global chord answers none unless ctrl or meta is held', () => {
  assert.deepEqual(settingsChordToIntent({ key: ',' }), { kind: 'none' })
  assert.deepEqual(settingsChordToIntent({ key: ',', shiftKey: true }), { kind: 'none' })
  assert.deepEqual(settingsChordToIntent({ key: ',', ctrlKey: true }), { kind: 'open' })
  assert.deepEqual(settingsChordToIntent({ key: ',', metaKey: true }), { kind: 'open' })
  assert.deepEqual(settingsChordToIntent({ key: 'a', ctrlKey: true }), { kind: 'none' })
})

test('the scoped handler ignores modified keys so the global chords still land', () => {
  const state = openState()
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter', metaKey: true }, state), { kind: 'none' })
})

test('escape unwinds form, then confirmation, then the screen — in that order', () => {
  const withDraft = applySettingsIntent(openState(), { kind: 'new-model' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, withDraft), { kind: 'cancel-draft' })

  const confirming = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, confirming), { kind: 'cancel-remove' })
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter' }, confirming), { kind: 'confirm-remove' })

  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, openState()), { kind: 'close' })
})

test('enter only confirms when something is actually pending', () => {
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter' }, openState()), { kind: 'none' })
})

// --- the reducer -------------------------------------------------------------

test('at most one form is open at a time', () => {
  const first = applySettingsIntent(openState(), { kind: 'new-endpoint' }).state
  assert.equal(first.draft?.kind, 'endpoint')
  const second = applySettingsIntent(first, { kind: 'new-model' }).state
  assert.equal(second.draft?.kind, 'model', 'the second form replaces the first rather than stacking')
})

test('opening asks for a load; closing does not', () => {
  const opened = applySettingsIntent(createSettingsState(), { kind: 'open' })
  assert.equal(opened.state.open, true)
  assert.equal(opened.load, true)
  const closed = applySettingsIntent(opened.state, { kind: 'close' })
  assert.equal(closed.state.open, false)
  assert.equal(closed.load, undefined)
})

test('a disabled category cannot be selected', () => {
  const next = applySettingsIntent(openState(), { kind: 'select-category', category: 'permissions' })
  assert.equal(next.state.category, 'provider', 'the three placeholder cards are not reachable yet')
})

test('switching project drops the stale snapshot and reloads', () => {
  const next = applySettingsIntent(openState(), { kind: 'select-project', projectRoot: 'C:\\repo\\beta' })
  assert.equal(next.state.snapshot, undefined, 'another project’s config must not linger on screen')
  assert.equal(next.load, true)
})

test('a routing select emits exactly one change and marks the screen busy', () => {
  const outcome = applySettingsIntent(openState(), { kind: 'set-routing', role: 'plan', value: 'big' })
  assert.deepEqual(outcome.changes, [
    { scope: 'provider', kind: 'set-routing', role: 'plan', value: 'big' },
  ])
  assert.equal(outcome.state.busy, true)
})

test('a delete needs the confirmation; confirming emits the removal', () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'endpoint', name: 'main' },
  })
  assert.equal(armed.changes, undefined, 'asking must not delete')
  const confirmed = applySettingsIntent(armed.state, { kind: 'confirm-remove' })
  assert.deepEqual(confirmed.changes, [{ scope: 'provider', kind: 'remove-endpoint', name: 'main' }])

  const cancelled = applySettingsIntent(armed.state, { kind: 'cancel-remove' })
  assert.equal(cancelled.state.confirmingRemove, undefined)
  assert.equal(cancelled.changes, undefined)
})

test('confirming with nothing pending deletes nothing', () => {
  const outcome = applySettingsIntent(openState(), { kind: 'confirm-remove' })
  assert.equal(outcome.changes, undefined)
})

// --- form validation ---------------------------------------------------------

function modelDraft(overrides: Partial<Extract<SettingsDraft, { kind: 'model' }>> = {}): SettingsDraft {
  return {
    kind: 'model',
    key: 'new',
    isNew: true,
    model: 'claude-new',
    endpoint: 'main',
    provider: '',
    contextWindow: '',
    maxOutputTokens: '',
    ...overrides,
  }
}

test('a model form rejects an empty key, an empty id and a duplicate key', () => {
  assert.deepEqual(draftToChange(modelDraft({ key: '  ' }), snapshotOf()), { error: '键名不能为空。' })
  assert.deepEqual(draftToChange(modelDraft({ model: '' }), snapshotOf()), { error: '模型 id 不能为空。' })
  const duplicate = draftToChange(modelDraft({ key: 'big' }), snapshotOf())
  assert.ok('error' in duplicate && /已经有一个叫 big/.test(duplicate.error))
})

test('a model form rejects a non-numeric context window', () => {
  const result = draftToChange(modelDraft({ contextWindow: '200k' }), snapshotOf())
  assert.ok('error' in result && /必须是数字/.test(result.error))
  const negative = draftToChange(modelDraft({ maxOutputTokens: '-5' }), snapshotOf())
  assert.ok('error' in negative)
})

test('a model with neither endpoint nor provider is rejected rather than saved unusable', () => {
  const result = draftToChange(modelDraft({ endpoint: '', provider: '' }), snapshotOf())
  assert.ok('error' in result)
})

test('blank numeric fields are omitted, not sent as zero', () => {
  const change = draftToChange(modelDraft(), snapshotOf())
  assert.ok(!('error' in change))
  assert.equal('contextWindow' in change, false)
  assert.equal('maxOutputTokens' in change, false)
})

test('renaming a model emits the rename before the write', () => {
  const changes = draftToChanges(
    modelDraft({ key: 'huge', isNew: false, originalKey: 'big', model: 'claude-big' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[0], { scope: 'provider', kind: 'rename-model', from: 'big', to: 'huge' })
  assert.equal(changes[1]?.kind, 'set-model')
})

test('editing a model without renaming it emits one change', () => {
  const changes = draftToChanges(
    modelDraft({ key: 'big', isNew: false, originalKey: 'big', model: 'claude-big-2' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.equal(changes.length, 1)
})

test('a duplicate endpoint name is rejected only when creating', () => {
  const dup = draftToChange(
    { kind: 'endpoint', name: 'main', isNew: true, provider: 'anthropic', baseUrl: '', apiKey: '', keyTouched: false },
    snapshotOf(),
  )
  assert.ok('error' in dup)
  const edit = draftToChange(
    { kind: 'endpoint', name: 'main', isNew: false, provider: 'anthropic', baseUrl: '', apiKey: '', keyTouched: false },
    snapshotOf(),
  )
  assert.ok(!('error' in edit))
})

// --- the view model ----------------------------------------------------------

test('the view marks the three unbuilt categories disabled with a reason', () => {
  const view = settingsView(openState())
  const disabled = view.nav.filter((item) => item.disabled).map((item) => item.category)
  assert.deepEqual(disabled, ['permissions', 'agent', 'general'])
  assert.ok(view.nav.every((item) => !item.disabled || item.disabledReason))
})

test('the view says which file it writes', () => {
  const view = settingsView(openState())
  assert.match(view.subtitle ?? '', /config\.json/)
})

test('an unresolvable model row carries a warning instead of being dropped', () => {
  const view = settingsView(openState())
  const models = view.cards.find((card) => card.id === 'models')
  const broken = models?.rows.find((row) => row.id === 'model:broken')
  assert.ok(broken, 'the row exists')
  assert.match(broken.warning ?? '', /无法解析/)
})

test('the default model row offers no redundant "set default" button', () => {
  const view = settingsView(openState())
  const models = view.cards.find((card) => card.id === 'models')
  const big = models?.rows.find((row) => row.id === 'model:big')
  assert.ok(big && big.control.kind === 'buttons')
  assert.ok(
    !big.control.buttons.some((button) => button.intent.kind === 'set-default-model'),
    'big is already the default',
  )
  const broken = models?.rows.find((row) => row.id === 'model:broken')
  assert.ok(broken && broken.control.kind === 'buttons')
  assert.ok(broken.control.buttons.some((button) => button.intent.kind === 'set-default-model'))
})

test('no endpoint row ever renders a raw key, only what the wire masked', () => {
  const view = settingsView(openState())
  const endpoints = view.cards.find((card) => card.id === 'endpoints')
  assert.match(endpoints?.rows[0]?.detail ?? '', /sk-a\.\.\.ijkl/)
})

test('a routing row has a select seeded with the current value', () => {
  const view = settingsView(openState())
  const routing = view.cards.find((card) => card.id === 'routing')
  const main = routing?.rows.find((row) => row.id === 'routing:main')
  assert.ok(main && main.control.kind === 'select')
  assert.equal(main.control.value, 'big')
  assert.deepEqual(main.control.intentOnChange('inherit'), {
    kind: 'set-routing',
    role: 'main',
    value: 'inherit',
  })
})

test('every configured subagent type gets its own routing row', () => {
  const view = settingsView(openState())
  const routing = view.cards.find((card) => card.id === 'routing')
  assert.ok(routing?.rows.some((row) => row.id === 'routing:subagent:explore'))
})

test('with no snapshot yet the screen draws no cards rather than empty ones', () => {
  const view = settingsView({ ...openState(), snapshot: undefined })
  assert.deepEqual(view.cards, [])
})

// --- effects -----------------------------------------------------------------

function fakeClient(overrides: Partial<SettingsClient> = {}): SettingsClient {
  return {
    getSettings: async () =>
      ({ settings: snapshotOf(), projects: [{ projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' }] }) as WireShellSettingsResult,
    changeSettings: async () =>
      ({ settings: snapshotOf({ defaultModel: 'broken' }), rebuiltLanes: 2 }) as WireShellSettingsChangeResult,
    ...overrides,
  }
}

test('loading folds the snapshot and the project list in', async () => {
  const state = await loadSettings(fakeClient(), { ...createSettingsState(), open: true })
  assert.equal(state.snapshot?.projectName, 'alpha')
  assert.equal(state.projectRoot, 'C:\\repo\\alpha')
  assert.equal(state.busy, false)
})

test('a failed load surfaces the message rather than throwing', async () => {
  const state = await loadSettings(
    fakeClient({
      getSettings: async () => {
        throw new Error('No project is open.')
      },
    }),
    { ...createSettingsState(), open: true },
  )
  assert.equal(state.error, 'No project is open.')
  assert.equal(state.busy, false)
})

test('a failed change keeps the snapshot on screen', async () => {
  const before = openState()
  const state = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('Model big is still referenced by routing')
      },
    }),
    before,
    [{ scope: 'provider', kind: 'remove-model', key: 'big' }],
  )
  assert.match(state.error ?? '', /still referenced/)
  assert.equal(state.snapshot, before.snapshot, 'an error must not blank the screen')
  assert.equal(state.busy, false)
})

test('changes run in order and the last reply wins', async () => {
  const sent: SettingsChange[] = []
  const state = await runSettingsChanges(
    fakeClient({
      changeSettings: async (_root, change) => {
        sent.push(change)
        return { settings: snapshotOf({ defaultModel: change.kind }), rebuiltLanes: 1 }
      },
    }),
    openState(),
    [
      { scope: 'provider', kind: 'rename-model', from: 'big', to: 'huge' },
      { scope: 'provider', kind: 'set-model', key: 'huge', model: 'claude-big' },
    ],
  )
  assert.deepEqual(
    sent.map((change) => change.kind),
    ['rename-model', 'set-model'],
    'the rename must land before the write, or the write creates a second model',
  )
  assert.equal(state.snapshot?.defaultModel, 'set-model')
})

test('a change with no project selected fails instead of guessing one', async () => {
  const state = await runSettingsChanges(fakeClient(), { ...createSettingsState(), open: true }, [
    { scope: 'provider', kind: 'set-default-model', key: 'big' },
  ])
  assert.ok(state.error)
})
