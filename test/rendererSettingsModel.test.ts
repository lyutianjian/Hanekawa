import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySettingsIntent,
  createSettingsState,
  draftToChange,
  draftToChanges,
  loadSettings,
  matchesQuery,
  pendingRowIds,
  projectSnapshot,
  routingOptions,
  runSettingsChanges,
  settingsChordToIntent,
  settingsKeyToIntent,
  settingsView,
  type SettingsClient,
  type SettingsDraft,
  type PendingMutation,
  type SettingsIntent,
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
    permissions: {
      localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
      mode: 'default',
      modeIsLocal: false,
      groups: [
        { behavior: 'allow', local: ['Bash(git status:*)'], inherited: ['Read'] },
        { behavior: 'ask', local: [], inherited: [] },
        { behavior: 'deny', local: [], inherited: ['Bash(rm -rf:*)'] },
      ],
    },
    agents: [
      {
        type: 'general',
        description: 'General-purpose sub-agent.',
        builtIn: true,
        maxTurns: 30,
        isReadOnlyAgent: true,
        routing: 'inherit',
      },
      {
        type: 'reviewer',
        description: 'Reviews a diff.',
        builtIn: false,
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
        model: 'claude-big',
        maxTurns: 12,
        isReadOnlyAgent: true,
        routing: 'big',
      },
    ],
    skills: [
      {
        name: 'release',
        description: 'Cuts a release.',
        enabled: true,
        inclusion: 'manual',
        hasHooks: false,
      },
      {
        name: 'review',
        description: 'Reviews a diff.',
        enabled: false,
        inclusion: 'fileMatch',
        paths: ['src/**'],
        allowedTools: ['Read', 'Grep'],
        model: 'claude-big',
        effort: 'high',
        hasHooks: true,
        attachments: 2,
      },
    ],
    skillsDir: 'C:\\repo\\alpha\\.myagent\\skills',
    mcpServers: [
      {
        name: 'github',
        transport: 'stdio',
        target: 'npx github-mcp',
        trusted: true,
        trustEditable: true,
        status: 'connected',
        toolCount: 3,
      },
      {
        name: 'shared',
        transport: 'sse',
        target: 'https://mcp.example',
        trusted: true,
        trustEditable: false,
        status: 'failed',
        error: 'connect ECONNREFUSED',
      },
      {
        name: 'cold',
        transport: 'stdio',
        target: 'cold-server',
        trusted: false,
        trustEditable: true,
        status: 'failed',
        error: 'not trusted',
      },
    ],
    contextManagement: {
      contextWindow: 200_000,
      summaryOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
      autoCompactThresholdRatio: 0.93,
    },
    general: { localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json' },
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

test('escape unwinds form, then confirmation, then the filter, then the screen — in that order', () => {
  const withDraft = applySettingsIntent(openState(), { kind: 'new-model' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, withDraft), { kind: 'cancel-draft' })

  const confirming = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, confirming), { kind: 'cancel-remove' })
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter' }, confirming), { kind: 'confirm-remove' })

  const searching = applySettingsIntent(openState(), { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, searching), { kind: 'clear-search' })

  // The two inner layers outrank the filter: a filter is a state of the screen,
  // and dismissing it must not cost a half-typed form or an armed delete.
  const draftingAndSearching = applySettingsIntent(withDraft, { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, draftingAndSearching), { kind: 'cancel-draft' })
  const confirmingAndSearching = applySettingsIntent(confirming, { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, confirmingAndSearching), { kind: 'cancel-remove' })

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

test('every category can be selected, and switching one drops an open form', () => {
  // Replaces "a disabled category cannot be selected": all four are built, and
  // `cardsFor` is now a `switch` with no `default`, so the compiler is what
  // stops a fifth from shipping empty.
  const drafting = applySettingsIntent(openState(), { kind: 'new-endpoint' })
  const next = applySettingsIntent(drafting.state, { kind: 'select-category', category: 'permissions' })
  assert.equal(next.state.category, 'permissions')
  assert.equal(next.state.draft, undefined, 'a provider form must not survive onto another page')
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

function endpointDraft(
  overrides: Partial<Extract<SettingsDraft, { kind: 'endpoint' }>> = {},
): SettingsDraft {
  return {
    kind: 'endpoint',
    name: 'main',
    isNew: true,
    provider: 'anthropic',
    baseUrl: '',
    apiKey: '',
    keyTouched: false,
    modelKey: '',
    modelId: '',
    ...overrides,
  }
}

/** Wraps changes the way `applySettingsIntent` does, so `runSettingsChanges` takes them. */
function pendingOf(...changes: SettingsChange[]): PendingMutation[] {
  return changes.map((change, id) => ({ id, change }))
}

function modelDraft(overrides: Partial<Extract<SettingsDraft, { kind: 'model' }>> = {}): SettingsDraft {
  return {
    kind: 'model',
    key: 'new',
    isNew: true,
    model: 'claude-new',
    endpoint: 'main',
    provider: '',
    contextWindow: '',
    longContext1m: '',
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
  // Off is absence, not `false`: `applyProviderChange` rebuilds the whole
  // `ModelConfig`, so an omitted field is how the switch gets removed.
  assert.equal('longContext1m' in change, false)
})

test('the 1M header switch round-trips through the model form', () => {
  const snapshot = snapshotOf({
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', contextWindow: 1_000_000, longContext1m: true, resolves: true },
    ],
    defaultModel: 'big',
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
  })

  // Seeded from the snapshot, or editing a model would silently switch it off.
  const opened = applySettingsIntent(
    openState({ category: 'provider', snapshot }),
    { kind: 'edit-model', key: 'big' },
  ).state
  assert.ok(opened.draft?.kind === 'model')
  assert.equal(opened.draft.longContext1m, 'on')

  const change = draftToChange(opened.draft, snapshot)
  assert.ok(!('error' in change) && change.kind === 'set-model')
  assert.equal(change.longContext1m, true)

  // Optimistic: the row must not blink back to off between save and refresh.
  const projected = projectSnapshot(snapshot, pendingOf(change))
  assert.equal(projected.models.find((model) => model.key === 'big')?.longContext1m, true)

  // And the model list says which models carry it.
  const card = settingsView(openState({ category: 'provider', snapshot })).cards
    .find((card) => card.id === 'models')
  const row = card?.rows.find((row) => row.id === 'model:big')
  assert.match(row?.detail ?? '', /1M 请求头/)
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
    endpointDraft({ name: 'main', isNew: true }),
    snapshotOf(),
  )
  assert.ok('error' in dup)
  const edit = draftToChange(
    endpointDraft({ name: 'main', isNew: false }),
    snapshotOf(),
  )
  assert.ok(!('error' in edit))
})

// --- the view model ----------------------------------------------------------

test('every category draws its own cards, and none draws a placeholder', () => {
  for (const category of ['provider', 'extensions', 'permissions', 'agent', 'general', 'appearance'] as const) {
    const view = settingsView(openState({ category }))
    assert.ok(view.cards.length > 0, `${category} has no cards`)
    assert.ok(
      view.cards.every((card) => card.id !== 'pending'),
      `${category} still draws the placeholder card`,
    )
  }
  assert.deepEqual(
    settingsView(openState()).navGroups.flatMap((group) => group.items.map((item) => item.category)),
    ['general', 'appearance', 'provider', 'extensions', 'permissions', 'agent'],
  )
})

test('the nav is three named sections, and every page lands in exactly one', () => {
  const groups = settingsView(openState()).navGroups
  assert.deepEqual(
    groups.map((group) => [group.group, group.label]),
    [
      ['personal', '个人'],
      ['integration', '集成'],
      ['coding', '编码'],
    ],
  )
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.category)),
    [['general', 'appearance'], ['provider', 'extensions'], ['permissions', 'agent']],
  )
  // Each item carries the section it was filed under, so the DOM never has to
  // re-derive the grouping (two views of one list is how they come to disagree).
  for (const group of groups) {
    assert.ok(group.items.length > 0, `${group.group} is an empty section`)
    for (const item of group.items) assert.equal(item.group, group.group)
  }
})

// --- the search box ----------------------------------------------------------

test('the query filters the nav to the pages that hold a match', () => {
  // 「MCP」 appears only on the extensions page (the MCP server card), so the
  // personal and coding sections drop out entirely.
  const view = settingsView(openState({ category: 'extensions', query: 'MCP' }))
  assert.deepEqual(
    view.navGroups.map((group) => group.items.map((item) => item.category)),
    [['extensions']],
  )
})

test('the selected page never leaves the nav, however unmatched it is', () => {
  // Otherwise a query can delete the row the user is standing on, and there is no
  // way back to it — which is also why the nav has no empty state.
  const view = settingsView(openState({ category: 'agent', query: 'MCP' }))
  const categories = view.navGroups.flatMap((group) => group.items.map((item) => item.category))
  assert.ok(categories.includes('agent'), 'the selected page survives its own filter')
  assert.ok(categories.includes('extensions'), 'and the page that actually matched is there too')
  const selected = view.navGroups.flatMap((group) => group.items).filter((item) => item.selected)
  assert.deepEqual(selected.map((item) => item.category), ['agent'])
})

test('a card that matches on its own title keeps all of its rows', () => {
  // Searching 「MCP」 must show the server list, not an empty MCP card.
  const view = settingsView(openState({ category: 'extensions', query: 'MCP' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['mcp'])
  assert.equal(view.cards[0]?.rows.length, snapshotOf().mcpServers.length)
  assert.equal(view.searchEmpty, undefined)
})

test('a card that does not match itself keeps only its matching rows', () => {
  const view = settingsView(openState({ category: 'general', query: '压缩预留' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['context'])
  assert.deepEqual(
    view.cards[0]?.rows.map((row) => row.id),
    ['context:autoCompactBufferTokens', 'context:manualCompactBufferTokens'],
  )
})

test('matching is case-insensitive and trimmed', () => {
  // Asserted on the matcher itself, in both directions: the screen's own text
  // happens to contain 「MCP」 in both cases, so a view-level assertion alone
  // passes even when the folding is gone.
  assert.equal(matchesQuery('MCP', 'npx github-mcp'), true)
  assert.equal(matchesQuery('mcp', 'MCP 服务器'), true)
  assert.equal(matchesQuery('  mcp  ', 'MCP 服务器'), true)
  assert.equal(matchesQuery('mcp', '上下文管理'), false)
  assert.equal(matchesQuery('mcp', undefined), false)
  // An empty query matches everything, so callers need no special case.
  assert.equal(matchesQuery('', undefined), true)
  assert.equal(matchesQuery('   ', '上下文管理'), true)

  const loud = settingsView(openState({ category: 'extensions', query: '  mcp  ' }))
  assert.deepEqual(loud.cards.map((card) => card.id), ['mcp'])
  assert.equal(
    loud.cards[0]?.rows.length,
    snapshotOf().mcpServers.length,
    'the folded query matched the card title, so the card keeps every row',
  )
  // A query of nothing but whitespace is not a query at all.
  const blank = settingsView(openState({ category: 'general', query: '   ' }))
  assert.deepEqual(blank.cards.map((card) => card.id), ['general', 'context'])
  assert.equal(blank.searchEmpty, undefined)
})

test('an unmatched page draws one line, not a screen of empty cards', () => {
  const view = settingsView(openState({ category: 'general', query: 'zzz-nothing' }))
  assert.deepEqual(view.cards, [])
  assert.match(view.searchEmpty ?? '', /zzz-nothing/)
})

test('a page that has not loaded says so by staying silent, not by claiming no matches', () => {
  // 「还没有加载」 and 「没有匹配」 are different facts. Conflating them would tell
  // the user their query failed when the truth is that no project is open yet.
  const view = settingsView(openState({ snapshot: undefined, projectRoot: undefined, query: 'MCP' }))
  assert.deepEqual(view.cards, [])
  assert.equal(view.searchEmpty, undefined)
})

test('typing does not disarm a pending delete or clear an error', () => {
  const confirming = applySettingsIntent(openState({ error: '写入失败' }), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const typed = applySettingsIntent({ ...confirming, error: '写入失败' }, {
    kind: 'search',
    query: 'MCP',
  }).state
  assert.equal(typed.query, 'MCP')
  assert.deepEqual(typed.confirmingRemove, { kind: 'model', name: 'big' })
  assert.equal(typed.error, '写入失败')
})

test('clear-search empties the query and touches nothing else', () => {
  const searching = applySettingsIntent(openState({ category: 'agent' }), {
    kind: 'search',
    query: 'MCP',
  }).state
  const cleared = applySettingsIntent(searching, { kind: 'clear-search' })
  assert.equal(cleared.state.query, '')
  assert.equal(cleared.state.category, 'agent')
  assert.equal(cleared.changes, undefined, 'the filter is renderer-local')
  assert.equal(cleared.load, undefined)
})

test('reopening the screen starts with an empty query', () => {
  const searching = applySettingsIntent(openState(), { kind: 'search', query: 'MCP' }).state
  const closed = applySettingsIntent(searching, { kind: 'close' }).state
  assert.equal(closed.query, 'MCP', 'closing alone does not reset it')
  const reopened = applySettingsIntent(closed, { kind: 'open' }).state
  assert.equal(reopened.query, '', 'a freshly opened screen is not still filtered')
})

// --- the pill dropdowns ------------------------------------------------------

test('toggling a dropdown opens it, and toggling the same one closes it', () => {
  const opened = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(opened.state.openMenu, 'row:routing:main')
  assert.equal(opened.changes, undefined, 'expanding a picker is not a config write')
  const closed = applySettingsIntent(opened.state, { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(closed.state.openMenu, undefined)
})

test('opening a second dropdown closes the first', () => {
  // One field rather than a set: two open menus can overlap, and the screen has a
  // dozen selects on it at once.
  const first = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' })
  const second = applySettingsIntent(first.state, { kind: 'toggle-menu', menu: 'row:routing:plan' })
  assert.equal(second.state.openMenu, 'row:routing:plan')
})

test('close-menu is idempotent, because focus loss and Escape both mean closed', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  assert.equal(applySettingsIntent(open, { kind: 'close-menu' }).state.openMenu, undefined)
  const already = openState()
  assert.equal(applySettingsIntent(already, { kind: 'close-menu' }).state, already, 'no needless copy')
})

test('picking a value closes the dropdown, and so does anything else on screen', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  // The intent a menu item emits goes through `cleared`, which is what makes
  // "picking dismisses the menu" free rather than something each row remembers.
  for (const intent of [
    { kind: 'set-routing', role: 'main', value: 'inherit' },
    { kind: 'select-category', category: 'general' },
    { kind: 'search', query: 'MCP' },
    { kind: 'clear-search' },
    { kind: 'request-remove', target: { kind: 'model', name: 'big' } },
    { kind: 'close' },
  ] as const satisfies readonly SettingsIntent[]) {
    assert.equal(
      applySettingsIntent(open, intent).state.openMenu,
      undefined,
      `${intent.kind} left a menu hanging open`,
    )
  }
  const armed = applySettingsIntent(open, {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  assert.equal(applySettingsIntent(armed, { kind: 'cancel-remove' }).state.openMenu, undefined)
})

test('expanding a picker does not throw away an unread error', () => {
  const failed = { ...openState(), error: '写入失败' }
  const opened = applySettingsIntent(failed, { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(opened.state.error, '写入失败')
  assert.equal(opened.state.openMenu, 'row:routing:main')
})

test('escape closes an open dropdown before it touches the form', () => {
  const drafting = applySettingsIntent(openState(), { kind: 'new-model' }).state
  const withMenu = applySettingsIntent(drafting, { kind: 'toggle-menu', menu: 'row:x' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, withMenu), { kind: 'close-menu' })
  // A form field's menu is drawn on top of the form, so dismissing it must not
  // cost the half-typed form underneath.
  assert.ok(withMenu.draft, 'the form is still there to lose')
})

test('reopening the screen leaves no dropdown expanded', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  const closed = applySettingsIntent(open, { kind: 'close' }).state
  assert.equal(applySettingsIntent(closed, { kind: 'open' }).state.openMenu, undefined)
})

test('appearance draws its card even with no project loaded', () => {
  // Theme is renderer-local, so the appearance page must render before (and
  // without) a host snapshot — the early return ahead of the snapshot guard.
  const view = settingsView(openState({ category: 'appearance', snapshot: undefined, projectRoot: undefined }))
  const card = view.cards.find((c) => c.id === 'appearance')
  assert.ok(card, 'appearance card is drawn without a snapshot')
  const row = card.rows.find((r) => r.id === 'appearance:theme')
  assert.ok(row && row.control.kind === 'select', 'theme is a select row')
  assert.equal(row.control.value, 'system', 'the select is seeded from state.themePref')
  assert.deepEqual(row.control.choices.map((c) => c.value), ['system', 'dark', 'light'])
  assert.deepEqual(row.control.intentOnChange('dark'), { kind: 'set-theme', preference: 'dark' })
})

test('the renderer-local appearance page is searchable on its own, without a snapshot', () => {
  const base = { category: 'appearance', snapshot: undefined, projectRoot: undefined } as const
  const hit = settingsView(openState({ ...base, query: '主题' }))
  assert.deepEqual(hit.cards.map((card) => card.id), ['appearance'])
  const miss = settingsView(openState({ ...base, query: 'zzz-nothing' }))
  assert.deepEqual(miss.cards, [])
  assert.match(miss.searchEmpty ?? '', /zzz-nothing/)
})

test('set-theme is a client-only write: it updates state but never touches the wire', () => {
  const outcome = applySettingsIntent(openState({ themePref: 'system' }), {
    kind: 'set-theme',
    preference: 'light',
  })
  assert.equal(outcome.state.themePref, 'light')
  assert.equal(outcome.themePreference, 'light')
  assert.equal(outcome.changes, undefined, 'the theme is not a SettingsChange')
  assert.equal(outcome.load, undefined, 'the theme needs no reload')
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

// --- permissions --------------------------------------------------------------

function permissionsView(overrides: Partial<WireSettingsSnapshot> = {}) {
  return settingsView(openState({ category: 'permissions', snapshot: snapshotOf(overrides) }))
}

test('an inherited rule is drawn, labelled, and has no delete button', () => {
  // Drawn rather than hidden: it is being enforced. Hiding it would explain
  // neither why a tool is denied nor why deleting the rule you *can* see did
  // nothing.
  const allow = permissionsView().cards.find((card) => card.id === 'permissions:allow')
  const local = allow?.rows.find((row) => row.label === 'Bash(git status:*)')
  const inherited = allow?.rows.find((row) => row.label === 'Read')

  assert.ok(local && local.control.kind === 'buttons')
  assert.equal(local.control.buttons.length, 1, 'the local rule can be removed')
  assert.ok(inherited && inherited.control.kind === 'text')
  assert.equal(inherited.control.muted, true)
  assert.match(inherited.detail ?? '', /上层设置/)
})

test('adding a rule sends the whole local group, not just the new line', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'allow' },
  )
  const typed = applySettingsIntent(opened.state, { kind: 'draft-field', field: 'entry', value: 'Read' })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.deepEqual(submitted.changes, [
    {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'allow',
      // The host rewrites the local layer outright: sending only `Read` would
      // delete the rule that was already there.
      entries: ['Bash(git status:*)', 'Read'],
    },
  ])
})

test('a rule already in the local layer is rejected instead of duplicated', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'allow' },
  )
  const typed = applySettingsIntent(opened.state, {
    kind: 'draft-field',
    field: 'entry',
    value: '  Bash(git status:*)  ',
  })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.equal(submitted.changes, undefined)
  assert.match(submitted.state.error ?? '', /已经有这条规则/)
})

test('the new-rule form can change which group it lands in', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'allow' },
  )
  const switched = applySettingsIntent(opened.state, { kind: 'draft-field', field: 'behavior', value: 'deny' })
  const typed = applySettingsIntent(switched.state, { kind: 'draft-field', field: 'entry', value: 'Delete' })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.deepEqual(submitted.changes, [
    // `deny` has an inherited entry and no local one, so the group written is
    // exactly the one new line — the inherited rule stays in its own file.
    { scope: 'permissions', kind: 'set-permission-entries', behavior: 'deny', entries: ['Delete'] },
  ])
})

test('removing a rule drops one copy, not every match', () => {
  const state = openState({
    category: 'permissions',
    snapshot: snapshotOf({
      permissions: {
        localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
        mode: 'default',
        modeIsLocal: true,
        groups: [
          { behavior: 'allow', local: ['Read', 'Read', 'Write'], inherited: [] },
          { behavior: 'ask', local: [], inherited: [] },
          { behavior: 'deny', local: [], inherited: [] },
        ],
      },
    }),
  })

  const outcome = applySettingsIntent(state, {
    kind: 'remove-permission-rule',
    behavior: 'allow',
    entry: 'Read',
  })
  assert.deepEqual(outcome.changes, [
    {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'allow',
      entries: ['Read', 'Write'],
    },
  ])
})

test('the startup mode row says it does not reach an open session', () => {
  const card = permissionsView().cards.find((card) => card.id === 'permission-mode')
  const row = card?.rows[0]
  assert.ok(row && row.control.kind === 'select')
  assert.equal(row.control.value, 'default')
  assert.match(row.detail ?? '', /已经打开的会话/)
  assert.deepEqual(row.control.intentOnChange('bypass'), {
    kind: 'set-startup-permission-mode',
    mode: 'bypass',
  })
  // The mode is last-writer-wins across layers and the local layer is last, so
  // an inherited mode is still editable — unlike the concatenated groups.
  assert.match(card?.note ?? '', /settings\.local\.json/)
})

// --- agents -------------------------------------------------------------------

test('every agent definition gets a row, with its routing select', () => {
  const card = settingsView(openState({ category: 'agent' })).cards.find((card) => card.id === 'agents')
  const reviewer = card?.rows.find((row) => row.id === 'agent:reviewer')

  assert.deepEqual(card?.rows.map((row) => row.id), ['agent:general', 'agent:reviewer'])
  assert.ok(reviewer && reviewer.control.kind === 'select')
  assert.equal(reviewer.control.value, 'big')
  // Reuses the provider page's routing variant rather than inventing a second
  // path to the same config field.
  assert.deepEqual(reviewer.control.intentOnChange('inherit'), {
    kind: 'set-subagent-routing',
    type: 'reviewer',
    value: 'inherit',
  })
  assert.deepEqual(
    reviewer.control.choices,
    routingOptions(snapshotOf()),
    'the same choices the provider routing card offers',
  )
})

test('an agent with no tool list says "all tools", not "no tools"', () => {
  const card = settingsView(openState({ category: 'agent' })).cards.find((card) => card.id === 'agents')
  assert.match(card?.rows.find((row) => row.id === 'agent:general')?.detail ?? '', /工具：全部/)
  assert.match(card?.rows.find((row) => row.id === 'agent:reviewer')?.detail ?? '', /工具：Read、Grep/)
  assert.match(card?.rows.find((row) => row.id === 'agent:general')?.detail ?? '', /内置/)
  assert.match(card?.rows.find((row) => row.id === 'agent:reviewer')?.detail ?? '', /自定义/)
})

test('reloading definitions is one change and nothing else', () => {
  const outcome = applySettingsIntent(openState({ category: 'agent' }), {
    kind: 'reload-agent-definitions',
  })
  assert.deepEqual(outcome.changes, [{ scope: 'agent', kind: 'reload-agent-definitions' }])
  assert.equal(outcome.state.busy, true)
})

// --- general, MCP and the context budget --------------------------------------

test('an unset cache toggle says it follows the environment variable', () => {
  const view = settingsView(openState({ category: 'general' }))
  const row = view.cards.find((card) => card.id === 'general')?.rows.find((row) => row.id === 'general:cache-ttl')
  assert.ok(row && row.control.kind === 'toggle')
  assert.equal(row.control.value, false)
  // Unset is not the same as false: `should1hCacheTTL` falls through to
  // MYAGENT_PROMPT_CACHE_1H, and a bare "off" would misreport that.
  assert.match(row.detail ?? '', /MYAGENT_PROMPT_CACHE_1H/)
  assert.deepEqual(row.control.intentOnChange(true), { kind: 'set-cache-ttl', enabled: true })
})

test('the thinking toggle reads unset as on and off as a real off', () => {
  const unset = settingsView(openState({ category: 'general' }))
    .cards.find((card) => card.id === 'general')
    ?.rows.find((row) => row.id === 'general:thinking')
  assert.ok(unset && unset.control.kind === 'toggle')
  // Absent means on: `createRuntime` only sends `disabled` for an explicit false.
  assert.equal(unset.control.value, true)
  assert.deepEqual(unset.control.intentOnChange(false), { kind: 'set-thinking', enabled: false })

  const off = settingsView(openState({
    category: 'general',
    snapshot: snapshotOf({
      general: { localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json', thinking: false },
    }),
  }))
    .cards.find((card) => card.id === 'general')
    ?.rows.find((row) => row.id === 'general:thinking')
  assert.ok(off && off.control.kind === 'toggle')
  assert.equal(off.control.value, false)
  assert.match(off.detail ?? '', /不带 thinking 参数/)

  const outcome = applySettingsIntent(openState({ category: 'general' }), {
    kind: 'set-thinking',
    enabled: false,
  })
  assert.deepEqual(outcome.changes, [{ scope: 'general', kind: 'set-thinking', enabled: false }])
})

test('a trust granted by an upper layer is drawn but not toggleable', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find((card) => card.id === 'mcp')
  const shared = card?.rows.find((row) => row.id === 'mcp:shared')
  const github = card?.rows.find((row) => row.id === 'mcp:github')
  const cold = card?.rows.find((row) => row.id === 'mcp:cold')

  assert.ok(shared && shared.control.kind === 'toggle')
  assert.equal(shared.control.disabled, true, 'trust is unioned across layers; this one cannot be revoked here')
  assert.ok(github && github.control.kind === 'toggle')
  assert.equal(github.control.disabled, false)
  assert.match(github.detail ?? '', /已连接 · 3 个工具/)

  // `not trusted` is not a connection failure to warn about — it is the next
  // step, and the detail says so.
  assert.equal(cold?.warning, undefined)
  assert.match(cold?.detail ?? '', /未信任/)
  assert.match(shared.warning ?? '', /ECONNREFUSED/)
})

test('reconnecting and trusting are separate changes', () => {
  const trust = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-mcp-trust',
    name: 'cold',
    trusted: true,
  })
  assert.deepEqual(trust.changes, [
    { scope: 'extensions', kind: 'set-mcp-trust', name: 'cold', trusted: true },
  ])
  const reconnect = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'reconnect-mcp' })
  assert.deepEqual(reconnect.changes, [{ scope: 'extensions', kind: 'reconnect-mcp' }])
})

// --- skills -------------------------------------------------------------------

test('the skills card lists every skill, switched-off ones included', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find(
    (card) => card.id === 'skills',
  )
  assert.match(card?.note ?? '', /\.myagent\\skills/)
  assert.deepEqual(card?.rows.map((row) => row.id), ['skill:release', 'skill:review'])
  assert.equal(card?.rows[0]?.label, '/release')

  const release = card?.rows[0]
  assert.ok(release && release.control.kind === 'toggle')
  assert.equal(release.control.value, true)
  // Never disabled, unlike MCP trust: `skills.disabled` is replaced by the
  // merge rather than unioned, so the local layer can always switch one back on.
  assert.equal(release.control.disabled, undefined)
  assert.match(release.detail ?? '', /手动调用/)
  assert.match(release.detail ?? '', /工具：全部/)

  const review = card?.rows[1]
  assert.ok(review && review.control.kind === 'toggle')
  assert.equal(review.control.value, false)
  assert.match(review.detail ?? '', /按文件匹配/)
  assert.match(review.detail ?? '', /匹配 src\/\*\*/)
  assert.match(review.detail ?? '', /工具：Read、Grep/)
  assert.match(review.detail ?? '', /模型：claude-big/)
  assert.match(review.detail ?? '', /推理强度：high/)
  assert.match(review.detail ?? '', /带 hooks/)
  assert.match(review.detail ?? '', /2 个附件/)
  assert.match(review.detail ?? '', /已关闭/)
})

test('the skills card has an empty state and a reload button', () => {
  const card = settingsView(
    openState({ category: 'extensions', snapshot: snapshotOf({ skills: [] }) }),
  ).cards.find((card) => card.id === 'skills')
  assert.equal(card?.rows.length, 0)
  assert.match(card?.empty ?? '', /还没有技能/)
  // Import first: with no skills on disk it is the only useful action, and the
  // empty state points at it.
  assert.deepEqual(card?.footerButtons?.map((button) => button.intent), [
    { kind: 'import-skill' },
    { kind: 'reload-skills' },
  ])
})

test('a skill switch and a skill reload are each one change', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find(
    (card) => card.id === 'skills',
  )
  const release = card?.rows[0]
  assert.ok(release && release.control.kind === 'toggle')
  assert.deepEqual(release.control.intentOnChange(false), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })

  const off = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })
  assert.deepEqual(off.changes, [
    { scope: 'extensions', kind: 'set-skill-enabled', name: 'release', enabled: false },
  ])
  assert.equal(off.state.busy, true)

  const reload = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'reload-skills' })
  assert.deepEqual(reload.changes, [{ scope: 'extensions', kind: 'reload-skills' }])
})

test('the extensions page is the skills card and the MCP card, in that order', () => {
  const view = settingsView(openState({ category: 'extensions' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['skills', 'mcp'])
  // And the general page no longer carries MCP.
  const general = settingsView(openState({ category: 'general' }))
  assert.deepEqual(general.cards.map((card) => card.id), ['general', 'context'])
})

test('the context card names its file and says the numbers need a restart', () => {
  const card = settingsView(openState({ category: 'general' })).cards.find((card) => card.id === 'context')
  assert.match(card?.note ?? '', /config\.json/)
  assert.match(card?.note ?? '', /重启后生效/)
  assert.deepEqual(
    card?.rows.map((row) => row.id),
    [
      'context:contextWindow',
      'context:summaryOutputTokens',
      'context:autoCompactBufferTokens',
      'context:manualCompactBufferTokens',
      'context:microCompactThresholdRatio',
      'context:autoCompactThresholdRatio',
    ],
  )
  const window = card?.rows[0]
  assert.ok(window && window.control.kind === 'input')
  assert.equal(window.control.value, '200000')
  assert.deepEqual(window.control.intentOnCommit('400000'), {
    kind: 'set-context-value',
    field: 'contextWindow',
    value: '400000',
  })
})

test('a context number is validated here, so a typo is not a host error', () => {
  const state = openState({ category: 'general' })
  const cases: Array<{ field: 'contextWindow' | 'autoCompactThresholdRatio'; value: string; error: RegExp }> = [
    { field: 'contextWindow', value: '', error: /不能为空/ },
    { field: 'contextWindow', value: '2e5x', error: /必须是数字/ },
    { field: 'contextWindow', value: '0', error: /正整数/ },
    { field: 'contextWindow', value: '1.5', error: /正整数/ },
    { field: 'autoCompactThresholdRatio', value: '1.5', error: /比例/ },
    { field: 'autoCompactThresholdRatio', value: '0', error: /比例/ },
  ]
  for (const { field, value, error } of cases) {
    const outcome = applySettingsIntent(state, { kind: 'set-context-value', field, value })
    assert.equal(outcome.changes, undefined, `${field}=${value} must not be sent`)
    assert.match(outcome.state.error ?? '', error)
  }

  // A ratio of exactly 1 is legitimate: compact only when the window is full.
  const accepted = applySettingsIntent(state, {
    kind: 'set-context-value',
    field: 'autoCompactThresholdRatio',
    value: '1',
  })
  assert.deepEqual(accepted.changes, [
    { scope: 'general', kind: 'set-context-management', field: 'autoCompactThresholdRatio', value: 1 },
  ])
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
    pendingOf({ scope: 'provider', kind: 'remove-model', key: 'big' }),
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
    pendingOf(
      { scope: 'provider', kind: 'rename-model', from: 'big', to: 'huge' },
      { scope: 'provider', kind: 'set-model', key: 'huge', model: 'claude-big' },
    ),
  )
  assert.deepEqual(
    sent.map((change) => change.kind),
    ['rename-model', 'set-model'],
    'the rename must land before the write, or the write creates a second model',
  )
  assert.equal(state.snapshot?.defaultModel, 'set-model')
})

test('a change with no project selected fails instead of guessing one', async () => {
  const state = await runSettingsChanges(
    fakeClient(),
    { ...createSettingsState(), open: true },
    pendingOf({ scope: 'provider', kind: 'set-default-model', key: 'big' }),
  )
  assert.ok(state.error)
})

// --- the optimistic projection ------------------------------------------------

test('a pending removal takes the row off screen before the host answers', () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const outcome = applySettingsIntent(armed, { kind: 'confirm-remove' })

  assert.deepEqual(outcome.changes, [{ scope: 'provider', kind: 'remove-model', key: 'big' }])
  assert.equal(outcome.pending?.length, 1, 'the change is parked so the view can draw it')

  const view = settingsView(outcome.state)
  const models = view.cards.find((card) => card.id === 'models')
  assert.deepEqual(models?.rows.map((row) => row.id), ['model:broken'], 'no second click needed')
  // The snapshot itself is untouched, which is what makes the rollback free.
  assert.equal(outcome.state.snapshot?.models.length, 2)
})

test('removing an endpoint projects its models away too', () => {
  const state = openState()
  const projected = projectSnapshot(state.snapshot!, [
    { id: 0, change: { scope: 'provider', kind: 'remove-endpoint', name: 'main' } },
  ])
  assert.deepEqual(projected.endpoints, [])
  assert.deepEqual(projected.models.map((model) => model.key), ['broken'])
  // The promotion `ConfigService.removeModel` performs, mirrored.
  assert.equal(projected.defaultModel, 'broken')
})

test('a pending toggle keeps its row and marks it in flight', () => {
  const outcome = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })
  const skills = settingsView(outcome.state).cards.find((card) => card.id === 'skills')
  const release = skills?.rows.find((row) => row.id === 'skill:release')
  assert.equal(release?.pending, true)
  assert.ok(release?.control.kind === 'toggle' && release.control.value === false)
  assert.deepEqual([...pendingRowIds(outcome.state.pending)], ['skill:release'])
})

test('an import in flight is drawn on the button that started it', () => {
  const outcome = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'import-skill' })
  assert.deepEqual(outcome.changes, [{ scope: 'extensions', kind: 'import-skill' }])
  const skills = settingsView(outcome.state).cards.find((card) => card.id === 'skills')
  const importing = skills?.footerButtons?.find((button) => button.changeKind === 'import-skill')
  assert.equal(importing?.pending, true)
  assert.equal(
    skills?.footerButtons?.find((button) => button.changeKind === 'reload-skills')?.pending,
    undefined,
    'only the button whose change is in flight waits',
  )
})

test('a failed change retires its pending row so the real snapshot comes back', async () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const outcome = applySettingsIntent(armed, { kind: 'confirm-remove' })

  const after = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('模型 big 上还有会话「x」在跑，先中断它再删。')
      },
    }),
    outcome.state,
    outcome.pending!,
  )
  assert.deepEqual(after.pending, [], 'the optimistic row is withdrawn')
  const models = settingsView(after).cards.find((card) => card.id === 'models')
  assert.ok(models?.rows.some((row) => row.id === 'model:big'), 'and the row is back')
  assert.match(after.error ?? '', /在跑/)
})

// --- forms in their own card --------------------------------------------------

test('a new-model form is anchored to the models card, an edit to its row', () => {
  const created = settingsView(applySettingsIntent(openState(), { kind: 'new-model' }).state)
  assert.deepEqual(created.form?.anchor, { cardId: 'models' })

  const edited = settingsView(
    applySettingsIntent(openState(), { kind: 'edit-model', key: 'big' }).state,
  )
  assert.deepEqual(edited.form?.anchor, { cardId: 'models', rowId: 'model:big' })
})

test('a delete confirmation is anchored to the row it is about, and names the cascade', () => {
  const view = settingsView(
    applySettingsIntent(openState(), {
      kind: 'request-remove',
      target: { kind: 'endpoint', name: 'main' },
    }).state,
  )
  assert.deepEqual(view.confirming?.anchor, { cardId: 'endpoints', rowId: 'endpoint:main' })
  assert.match(view.confirming?.message ?? '', /将同时删除模型 big/)
})

// --- an endpoint and its first model ------------------------------------------

test('a new endpoint can carry its first model, and both fields are all-or-nothing', () => {
  const snapshot = snapshotOf({ models: [], defaultModel: undefined })

  const alone = draftToChanges(endpointDraft({ name: 'fresh' }), snapshot)
  assert.ok(Array.isArray(alone))
  assert.deepEqual(alone.map((change) => change.kind), ['set-endpoint'])

  const half = draftToChanges(endpointDraft({ name: 'fresh', modelKey: 'big' }), snapshot)
  assert.ok('error' in half)

  const both = draftToChanges(
    endpointDraft({ name: 'fresh', modelKey: 'big', modelId: 'claude-big' }),
    snapshot,
  )
  assert.ok(Array.isArray(both))
  assert.deepEqual(both.map((change) => change.kind), [
    'set-endpoint',
    'set-model',
    // Nothing was the default, so the model just added becomes it.
    'set-default-model',
  ])
  assert.equal(
    (both[1] as Extract<SettingsChange, { kind: 'set-model' }>).endpoint,
    'fresh',
    'the model must point at the endpoint created one change earlier',
  )
})

test('adding an endpoint does not move an existing default model', () => {
  const changes = draftToChanges(
    endpointDraft({ name: 'fresh', modelKey: 'other', modelId: 'claude-other' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.deepEqual(changes.map((change) => change.kind), ['set-endpoint', 'set-model'])
})
