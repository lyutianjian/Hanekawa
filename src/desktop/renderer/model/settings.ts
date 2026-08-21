import type {
  SettingsCategory,
  SettingsChange,
  WireEndpointInfo,
  WireModelInfo,
  WireSettingsSnapshot,
  WireShellSettingsChangeResult,
  WireShellSettingsResult,
} from '../../shellProtocol.js'

/**
 * The settings screen: pick a category, edit one thing at a time, save.
 *
 * Every decision the screen makes lives here as a pure function — which
 * category is shown, what each row says, what a form's fields turn into on the
 * wire, and which keystroke means what. `dom/settingsView.ts` only turns the
 * view model into nodes.
 *
 * DOM-free on purpose: this module is compiled by a test in the base tsconfig
 * program, where there is no DOM lib. Hence the structural key shape and the
 * structural `SettingsClient` below rather than `KeyboardEvent` and
 * `ShellClient`.
 *
 * The screen fills the canvas rather than floating over it (stage-4 decision:
 * settings is a window-level surface, not a modal), so it never blocks the
 * agent loop and never takes a `resolveKey` rank.
 *
 * Only the provider category is live. The other three are drawn disabled: each
 * one needs a decision that is not the screen's to make — permission rules
 * concatenate across settings layers, `agent.contextManagement` is snapshotted
 * at bootstrap, and MCP does not reconnect without new plumbing.
 */

// --- state -------------------------------------------------------------------

/** A form. At most one is open at a time — see `applySettingsIntent`. */
export type SettingsDraft =
  | {
      readonly kind: 'endpoint'
      readonly name: string
      readonly isNew: boolean
      readonly provider: string
      readonly baseUrl: string
      readonly apiKey: string
      /**
       * Whether the user typed in the key field.
       *
       * The field is seeded with a *mask*, so sending it unconditionally would
       * write `sk-a...ijkl` into the config as if it were the key. False means
       * the change omits `apiKey` entirely, which the host reads as "leave it".
       */
      readonly keyTouched: boolean
    }
  | {
      readonly kind: 'model'
      readonly key: string
      readonly isNew: boolean
      /** Set when editing: a changed `key` becomes a rename, not a second model. */
      readonly originalKey?: string
      readonly model: string
      readonly endpoint: string
      readonly provider: string
      readonly contextWindow: string
      readonly maxOutputTokens: string
    }

export interface SettingsState {
  readonly open: boolean
  readonly category: SettingsCategory
  /** A command is in flight; the screen keeps drawing but takes no input. */
  readonly busy: boolean
  readonly projectRoot?: string
  readonly snapshot?: WireSettingsSnapshot
  readonly projects: ReadonlyArray<{ projectRoot: string; projectName: string }>
  readonly draft?: SettingsDraft
  readonly confirmingRemove?: { readonly kind: 'endpoint' | 'model'; readonly name: string }
  readonly error?: string
}

export function createSettingsState(): SettingsState {
  return { open: false, category: 'provider', busy: false, projects: [] }
}

/** Categories that actually do something. The rest are drawn with a reason. */
export const LIVE_CATEGORIES: readonly SettingsCategory[] = ['provider']

export const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  provider: '模型与服务商',
  permissions: '权限',
  agent: 'Agent',
  general: '通用',
}

const CATEGORY_PENDING_REASON = '即将支持'

/** The `inherit` sentinel, spelled once. */
export const INHERIT = 'inherit'

// --- view model --------------------------------------------------------------

export interface SettingsNavItem {
  readonly category: SettingsCategory
  readonly label: string
  readonly selected: boolean
  readonly disabled: boolean
  readonly disabledReason?: string
}

/** A control on the right-hand side of a row. */
export type SettingsControl =
  | { readonly kind: 'text'; readonly value: string; readonly muted?: boolean }
  | {
      readonly kind: 'select'
      readonly value: string
      readonly choices: ReadonlyArray<{ value: string; label: string }>
      readonly intentOnChange: (value: string) => SettingsIntent
    }
  | { readonly kind: 'buttons'; readonly buttons: readonly SettingsButton[] }

export interface SettingsButton {
  readonly label: string
  readonly title: string
  readonly intent: SettingsIntent
  readonly danger?: boolean
  readonly icon?: 'trash' | 'plus'
}

export interface SettingsRow {
  readonly id: string
  readonly label: string
  readonly detail?: string
  /** Drawn in the accent-warning colour: the row is configured but unusable. */
  readonly warning?: string
  readonly control: SettingsControl
}

export interface SettingsCard {
  readonly id: string
  readonly title: string
  readonly note?: string
  readonly rows: readonly SettingsRow[]
  /** Shown in place of rows when there are none. */
  readonly empty?: string
  readonly footerButtons?: readonly SettingsButton[]
}

export interface SettingsFormField {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly mono?: boolean
  readonly choices?: ReadonlyArray<{ value: string; label: string }>
}

export interface SettingsForm {
  readonly title: string
  readonly fields: readonly SettingsFormField[]
  readonly submitLabel: string
}

export interface SettingsViewModel {
  readonly open: boolean
  readonly nav: readonly SettingsNavItem[]
  readonly title: string
  readonly subtitle?: string
  readonly cards: readonly SettingsCard[]
  readonly form?: SettingsForm
  readonly error?: string
  readonly busy: boolean
  readonly projectChoices: ReadonlyArray<{ value: string; label: string }>
  readonly projectValue: string
  readonly confirming?: { readonly message: string }
}

const ALL_CATEGORIES: readonly SettingsCategory[] = ['provider', 'permissions', 'agent', 'general']

export function settingsView(state: SettingsState): SettingsViewModel {
  const nav = ALL_CATEGORIES.map((category) => {
    const disabled = !LIVE_CATEGORIES.includes(category)
    const item: SettingsNavItem = {
      category,
      label: CATEGORY_LABELS[category],
      selected: state.category === category,
      disabled,
      ...(disabled ? { disabledReason: CATEGORY_PENDING_REASON } : {}),
    }
    return item
  })

  const base = {
    open: state.open,
    nav,
    busy: state.busy,
    projectChoices: state.projects.map((project) => ({
      value: project.projectRoot,
      label: project.projectName,
    })),
    projectValue: state.projectRoot ?? '',
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.confirmingRemove
      ? { confirming: { message: removeConfirmMessage(state.confirmingRemove) } }
      : {}),
  }

  if (!state.snapshot) {
    return { ...base, title: CATEGORY_LABELS[state.category], cards: [] }
  }
  if (state.category !== 'provider') {
    return {
      ...base,
      title: CATEGORY_LABELS[state.category],
      cards: [{ id: 'pending', title: CATEGORY_LABELS[state.category], rows: [], empty: CATEGORY_PENDING_REASON }],
    }
  }

  return {
    ...base,
    title: CATEGORY_LABELS.provider,
    subtitle: `配置写入 ${state.snapshot.saveTarget}`,
    cards: providerCards(state.snapshot),
    ...(state.draft ? { form: draftForm(state.draft, state.snapshot) } : {}),
  }
}

function removeConfirmMessage(target: { kind: 'endpoint' | 'model'; name: string }): string {
  return target.kind === 'endpoint' ? `删除服务商 ${target.name}？` : `删除模型 ${target.name}？`
}

function providerCards(snapshot: WireSettingsSnapshot): SettingsCard[] {
  return [endpointsCard(snapshot), modelsCard(snapshot), routingCard(snapshot)]
}

function endpointsCard(snapshot: WireSettingsSnapshot): SettingsCard {
  return {
    id: 'endpoints',
    title: '服务商接入点',
    note: 'API key 只在本机保存，界面上始终以掩码显示。',
    empty: '还没有接入点。',
    rows: snapshot.endpoints.map((endpoint) => ({
      id: `endpoint:${endpoint.name}`,
      label: endpoint.name,
      detail: endpointDetail(endpoint),
      control: {
        kind: 'buttons' as const,
        buttons: [
          {
            label: '编辑',
            title: `编辑 ${endpoint.name}`,
            intent: { kind: 'edit-endpoint', name: endpoint.name } as SettingsIntent,
          },
          {
            label: '',
            title: `删除 ${endpoint.name}`,
            icon: 'trash' as const,
            danger: true,
            intent: {
              kind: 'request-remove',
              target: { kind: 'endpoint', name: endpoint.name },
            } as SettingsIntent,
          },
        ],
      },
    })),
    footerButtons: [
      { label: '新增接入点', title: '新增接入点', icon: 'plus', intent: { kind: 'new-endpoint' } },
    ],
  }
}

function endpointDetail(endpoint: WireEndpointInfo): string {
  const parts = [endpoint.provider]
  if (endpoint.baseUrl) parts.push(endpoint.baseUrl)
  parts.push(endpoint.apiKeyMasked ? `key ${endpoint.apiKeyMasked}` : '未设置 key')
  return parts.join(' · ')
}

function modelsCard(snapshot: WireSettingsSnapshot): SettingsCard {
  return {
    id: 'models',
    title: '模型',
    note: `默认模型：${snapshot.defaultModel ?? '未设置'}`,
    empty: '还没有配置模型。',
    rows: snapshot.models.map((model) => {
      const row: SettingsRow = {
        id: `model:${model.key}`,
        label: model.key,
        detail: modelDetail(model),
        // Drawn rather than filtered: a model that is configured but cannot run
        // has to say why, or the user is left with a key that silently does
        // nothing wherever it is routed.
        ...(model.resolves ? {} : { warning: '无法解析：检查它的接入点' }),
        control: {
          kind: 'buttons' as const,
          buttons: [
            ...(snapshot.defaultModel === model.key
              ? []
              : [
                  {
                    label: '设为默认',
                    title: `把 ${model.key} 设为默认模型`,
                    intent: { kind: 'set-default-model', key: model.key } as SettingsIntent,
                  },
                ]),
            {
              label: '编辑',
              title: `编辑 ${model.key}`,
              intent: { kind: 'edit-model', key: model.key } as SettingsIntent,
            },
            {
              label: '',
              title: `删除 ${model.key}`,
              icon: 'trash' as const,
              danger: true,
              intent: {
                kind: 'request-remove',
                target: { kind: 'model', name: model.key },
              } as SettingsIntent,
            },
          ],
        },
      }
      return row
    }),
    footerButtons: [{ label: '新增模型', title: '新增模型', icon: 'plus', intent: { kind: 'new-model' } }],
  }
}

function modelDetail(model: WireModelInfo): string {
  const parts = [model.model]
  if (model.endpoint) parts.push(`接入点 ${model.endpoint}`)
  else if (model.provider) parts.push(model.provider)
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k 上下文`)
  return parts.join(' · ')
}

const ROUTING_ROLE_LABELS: Record<'main' | 'plan' | 'compact', string> = {
  main: '主循环',
  plan: '计划模式',
  compact: '压缩',
}

function routingCard(snapshot: WireSettingsSnapshot): SettingsCard {
  const choices = routingOptions(snapshot)
  const roles = (['main', 'plan', 'compact'] as const).map((role) => ({
    id: `routing:${role}`,
    label: ROUTING_ROLE_LABELS[role],
    control: {
      kind: 'select' as const,
      value: snapshot.routing[role],
      choices,
      intentOnChange: (value: string): SettingsIntent => ({ kind: 'set-routing', role, value }),
    },
  }))
  const subagents = snapshot.routing.subagent.map((entry) => ({
    id: `routing:subagent:${entry.type}`,
    label: `子 agent · ${entry.type}`,
    control: {
      kind: 'select' as const,
      value: entry.value,
      choices,
      intentOnChange: (value: string): SettingsIntent => ({
        kind: 'set-subagent-routing',
        type: entry.type,
        value,
      }),
    },
  }))
  return {
    id: 'routing',
    title: '路由',
    note: `${INHERIT} 表示跟随主循环所用的模型。`,
    rows: [...roles, ...subagents],
  }
}

/**
 * The choices a routing select offers: `inherit` first, then every configured
 * model key.
 *
 * A key that does not resolve stays in the list, labelled. Dropping it would
 * hide the reason a role is misbehaving and would silently rewrite the user's
 * config the moment they touched any *other* select on the screen.
 */
export function routingOptions(
  snapshot: WireSettingsSnapshot,
): Array<{ value: string; label: string }> {
  return [
    { value: INHERIT, label: `${INHERIT}（跟随主模型）` },
    ...snapshot.models.map((model) => ({
      value: model.key,
      label: model.resolves ? model.key : `${model.key}（无法解析）`,
    })),
  ]
}

// --- forms -------------------------------------------------------------------

function draftForm(draft: SettingsDraft, snapshot: WireSettingsSnapshot): SettingsForm {
  if (draft.kind === 'endpoint') {
    return {
      title: draft.isNew ? '新增接入点' : `编辑接入点 ${draft.name}`,
      submitLabel: '保存',
      fields: [
        { id: 'name', label: '名称', value: draft.name, placeholder: '例如 main' },
        {
          id: 'provider',
          label: '服务商',
          value: draft.provider,
          choices: snapshot.providers.map((provider) => ({ value: provider, label: provider })),
        },
        { id: 'baseUrl', label: 'Base URL', value: draft.baseUrl, mono: true, placeholder: '留空使用默认' },
        {
          id: 'apiKey',
          label: 'API key',
          value: draft.apiKey,
          mono: true,
          placeholder: draft.isNew ? '' : '留空表示不修改',
        },
      ],
    }
  }
  return {
    title: draft.isNew ? '新增模型' : `编辑模型 ${draft.originalKey ?? draft.key}`,
    submitLabel: '保存',
    fields: [
      { id: 'key', label: '键名', value: draft.key, placeholder: '例如 big' },
      { id: 'model', label: '模型 id', value: draft.model, mono: true, placeholder: '例如 claude-opus-5' },
      {
        id: 'endpoint',
        label: '接入点',
        value: draft.endpoint,
        choices: [
          { value: '', label: '（不使用接入点）' },
          ...snapshot.endpoints.map((endpoint) => ({ value: endpoint.name, label: endpoint.name })),
        ],
      },
      {
        id: 'provider',
        label: '服务商',
        value: draft.provider,
        choices: [
          { value: '', label: '（跟随接入点）' },
          ...snapshot.providers.map((provider) => ({ value: provider, label: provider })),
        ],
      },
      { id: 'contextWindow', label: '上下文窗口', value: draft.contextWindow, placeholder: '例如 200000' },
      { id: 'maxOutputTokens', label: '最大输出 token', value: draft.maxOutputTokens, placeholder: '可留空' },
    ],
  }
}

/**
 * A form's fields → the change to send, or the reason it cannot be sent.
 *
 * The `apiKey` rule is the load-bearing one: an untouched key field is showing
 * a mask, so the field is omitted rather than sent. Emptying a key that was set
 * is a `clear-endpoint-key`, which is why an empty *touched* field on an
 * existing endpoint does not simply send `apiKey: ''`.
 */
export function draftToChange(
  draft: SettingsDraft,
  snapshot: WireSettingsSnapshot,
): SettingsChange | { error: string } {
  if (draft.kind === 'endpoint') {
    const name = draft.name.trim()
    if (!name) return { error: '名称不能为空。' }
    if (draft.isNew && snapshot.endpoints.some((endpoint) => endpoint.name === name)) {
      return { error: `已经有一个叫 ${name} 的接入点。` }
    }
    if (!draft.provider) return { error: '请选择服务商。' }
    const change: SettingsChange = { scope: 'provider', kind: 'set-endpoint', name, provider: draft.provider }
    const baseUrl = draft.baseUrl.trim()
    if (baseUrl) change.baseUrl = baseUrl
    if (draft.keyTouched) change.apiKey = draft.apiKey.trim()
    return change
  }

  const key = draft.key.trim()
  if (!key) return { error: '键名不能为空。' }
  const model = draft.model.trim()
  if (!model) return { error: '模型 id 不能为空。' }
  if (key !== draft.originalKey && snapshot.models.some((existing) => existing.key === key)) {
    return { error: `已经有一个叫 ${key} 的模型。` }
  }
  if (!draft.endpoint && !draft.provider) {
    return { error: '请选择接入点，或直接指定服务商。' }
  }
  const contextWindow = parseCount(draft.contextWindow)
  if (contextWindow === 'invalid') return { error: '上下文窗口必须是数字。' }
  const maxOutputTokens = parseCount(draft.maxOutputTokens)
  if (maxOutputTokens === 'invalid') return { error: '最大输出 token 必须是数字。' }

  const change: SettingsChange = { scope: 'provider', kind: 'set-model', key, model }
  if (draft.endpoint) change.endpoint = draft.endpoint
  if (draft.provider) change.provider = draft.provider
  if (contextWindow !== undefined) change.contextWindow = contextWindow
  if (maxOutputTokens !== undefined) change.maxOutputTokens = maxOutputTokens
  return change
}

function parseCount(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return 'invalid'
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : 'invalid'
}

/**
 * Renaming a model is its own command, so a submitted model form can be *two*
 * changes. The rename must go first: `set-model` under the new key would
 * otherwise create a second model and leave the old one behind.
 */
export function draftToChanges(
  draft: SettingsDraft,
  snapshot: WireSettingsSnapshot,
): SettingsChange[] | { error: string } {
  const change = draftToChange(draft, snapshot)
  if ('error' in change) return change
  if (draft.kind === 'model' && draft.originalKey && draft.originalKey !== draft.key.trim()) {
    return [
      { scope: 'provider', kind: 'rename-model', from: draft.originalKey, to: draft.key.trim() },
      change,
    ]
  }
  return [change]
}

// --- keys --------------------------------------------------------------------

/** Structural, because there is no DOM in the test runner. */
export interface SettingsChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * The *global* entry point, resolved before `resolveKey` — which is only safe
 * because it answers `'none'` unless ctrl or meta is held. The sidebar's chord
 * handler works exactly this way and for exactly this reason.
 */
export function settingsChordToIntent(chord: SettingsChord): SettingsIntent {
  if (!chord.ctrlKey && !chord.metaKey) return { kind: 'none' }
  if (chord.key === ',') return { kind: 'open' }
  return { kind: 'none' }
}

/**
 * The *scoped* entry point, bound to the settings container.
 *
 * Escape unwinds one layer at a time — form, then delete confirmation, then the
 * screen — so an open form cannot be lost by a reflexive Escape aimed at the
 * screen. Answers `'none'` for any modified key so the global chords still get
 * through.
 */
export function settingsKeyToIntent(chord: SettingsChord, state: SettingsState): SettingsIntent {
  if (chord.ctrlKey || chord.metaKey) return { kind: 'none' }
  if (chord.key === 'Escape') {
    if (state.draft) return { kind: 'cancel-draft' }
    if (state.confirmingRemove) return { kind: 'cancel-remove' }
    return { kind: 'close' }
  }
  if (chord.key === 'Enter' && state.confirmingRemove) return { kind: 'confirm-remove' }
  return { kind: 'none' }
}

// --- intents and transitions -------------------------------------------------

export type SettingsIntent =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'select-category'; category: SettingsCategory }
  | { kind: 'select-project'; projectRoot: string }
  | { kind: 'new-endpoint' }
  | { kind: 'edit-endpoint'; name: string }
  | { kind: 'new-model' }
  | { kind: 'edit-model'; key: string }
  | { kind: 'draft-field'; field: string; value: string }
  | { kind: 'submit-draft' }
  | { kind: 'cancel-draft' }
  | { kind: 'request-remove'; target: { kind: 'endpoint' | 'model'; name: string } }
  | { kind: 'confirm-remove' }
  | { kind: 'cancel-remove' }
  | { kind: 'set-default-model'; key: string }
  | { kind: 'set-routing'; role: 'main' | 'plan' | 'compact'; value: string }
  | { kind: 'set-subagent-routing'; type: string; value: string }
  | { kind: 'none' }

export interface SettingsOutcome {
  readonly state: SettingsState
  /** Changes to send, in order. The caller runs them and folds the reply back. */
  readonly changes?: readonly SettingsChange[]
  /** The caller should (re)load the snapshot for `state.projectRoot`. */
  readonly load?: boolean
}

/**
 * The reducer. Exhaustive by `switch` over `intent.kind` with no `default`.
 *
 * Two rules hold across every branch: at most one form is open (opening a
 * second discards the first rather than stacking), and any transition that
 * changes what is on screen clears a stale error, so a failure message cannot
 * outlive the thing it was about.
 */
export function applySettingsIntent(state: SettingsState, intent: SettingsIntent): SettingsOutcome {
  const cleared = { ...state, error: undefined, confirmingRemove: undefined }
  switch (intent.kind) {
    case 'none':
      return { state }
    case 'open':
      if (state.open) return { state }
      return { state: { ...cleared, open: true, draft: undefined }, load: true }
    case 'close':
      return { state: { ...cleared, open: false, draft: undefined } }
    case 'select-category':
      if (!LIVE_CATEGORIES.includes(intent.category)) return { state }
      return { state: { ...cleared, category: intent.category, draft: undefined } }
    case 'select-project':
      if (intent.projectRoot === state.projectRoot) return { state }
      return {
        state: { ...cleared, projectRoot: intent.projectRoot, draft: undefined, snapshot: undefined },
        load: true,
      }

    case 'new-endpoint':
      return {
        state: {
          ...cleared,
          draft: {
            kind: 'endpoint',
            name: '',
            isNew: true,
            provider: state.snapshot?.providers[0] ?? '',
            baseUrl: '',
            apiKey: '',
            keyTouched: false,
          },
        },
      }
    case 'edit-endpoint': {
      const endpoint = state.snapshot?.endpoints.find((candidate) => candidate.name === intent.name)
      if (!endpoint) return { state }
      return {
        state: {
          ...cleared,
          draft: {
            kind: 'endpoint',
            name: endpoint.name,
            isNew: false,
            provider: endpoint.provider,
            baseUrl: endpoint.baseUrl ?? '',
            // Seeded empty rather than with the mask: an empty field with a
            // "留空表示不修改" placeholder cannot be mistaken for the real key,
            // and `keyTouched` is what actually decides whether it is sent.
            apiKey: '',
            keyTouched: false,
          },
        },
      }
    }
    case 'new-model':
      return {
        state: {
          ...cleared,
          draft: {
            kind: 'model',
            key: '',
            isNew: true,
            model: '',
            endpoint: state.snapshot?.endpoints[0]?.name ?? '',
            provider: '',
            contextWindow: '',
            maxOutputTokens: '',
          },
        },
      }
    case 'edit-model': {
      const model = state.snapshot?.models.find((candidate) => candidate.key === intent.key)
      if (!model) return { state }
      return {
        state: {
          ...cleared,
          draft: {
            kind: 'model',
            key: model.key,
            isNew: false,
            originalKey: model.key,
            model: model.model,
            endpoint: model.endpoint ?? '',
            provider: model.provider ?? '',
            contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
            maxOutputTokens: model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
          },
        },
      }
    }
    case 'draft-field': {
      if (!state.draft) return { state }
      return { state: { ...cleared, draft: withField(state.draft, intent.field, intent.value) } }
    }
    case 'cancel-draft':
      return { state: { ...cleared, draft: undefined } }
    case 'submit-draft': {
      if (!state.draft || !state.snapshot) return { state }
      const changes = draftToChanges(state.draft, state.snapshot)
      if ('error' in changes) return { state: { ...state, error: changes.error } }
      return { state: { ...cleared, draft: undefined, busy: true }, changes }
    }

    case 'request-remove':
      return { state: { ...state, error: undefined, confirmingRemove: intent.target } }
    case 'cancel-remove':
      return { state: { ...state, confirmingRemove: undefined } }
    case 'confirm-remove': {
      const target = state.confirmingRemove
      if (!target) return { state }
      return {
        state: { ...cleared, busy: true },
        changes: [
          target.kind === 'endpoint'
            ? { scope: 'provider', kind: 'remove-endpoint', name: target.name }
            : { scope: 'provider', kind: 'remove-model', key: target.name },
        ],
      }
    }

    case 'set-default-model':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'provider', kind: 'set-default-model', key: intent.key }],
      }
    case 'set-routing':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'provider', kind: 'set-routing', role: intent.role, value: intent.value }],
      }
    case 'set-subagent-routing':
      return {
        state: { ...cleared, busy: true },
        changes: [
          { scope: 'provider', kind: 'set-subagent-routing', type: intent.type, value: intent.value },
        ],
      }
  }
}

function withField(draft: SettingsDraft, field: string, value: string): SettingsDraft {
  if (draft.kind === 'endpoint') {
    switch (field) {
      case 'name':
        return { ...draft, name: value }
      case 'provider':
        return { ...draft, provider: value }
      case 'baseUrl':
        return { ...draft, baseUrl: value }
      case 'apiKey':
        // Typing here is the *only* thing that arms the key for sending.
        return { ...draft, apiKey: value, keyTouched: true }
      default:
        return draft
    }
  }
  switch (field) {
    case 'key':
      return { ...draft, key: value }
    case 'model':
      return { ...draft, model: value }
    case 'endpoint':
      return { ...draft, endpoint: value }
    case 'provider':
      return { ...draft, provider: value }
    case 'contextWindow':
      return { ...draft, contextWindow: value }
    case 'maxOutputTokens':
      return { ...draft, maxOutputTokens: value }
    default:
      return draft
  }
}

// --- effects -----------------------------------------------------------------

/** Structural: a test passes a plain object, not a `ShellClient`. */
export interface SettingsClient {
  getSettings(projectRoot?: string): Promise<WireShellSettingsResult>
  changeSettings(projectRoot: string, change: SettingsChange): Promise<WireShellSettingsChangeResult>
}

export async function loadSettings(
  client: SettingsClient,
  state: SettingsState,
): Promise<SettingsState> {
  try {
    const result = await client.getSettings(state.projectRoot)
    return {
      ...state,
      busy: false,
      error: undefined,
      snapshot: result.settings,
      projects: result.projects,
      projectRoot: result.settings.projectRoot,
    }
  } catch (error) {
    return { ...state, busy: false, error: messageOf(error) }
  }
}

/**
 * Runs a batch of changes in order, folding each reply's snapshot in.
 *
 * Sequential rather than concurrent: a rename followed by a `set-model` is the
 * batch this exists for, and the second depends on the first having landed.
 * A failure keeps the snapshot the screen is already drawing — blanking it
 * would replace a recoverable error with an empty screen.
 */
export async function runSettingsChanges(
  client: SettingsClient,
  state: SettingsState,
  changes: readonly SettingsChange[],
): Promise<SettingsState> {
  const projectRoot = state.projectRoot
  if (projectRoot === undefined) {
    return { ...state, busy: false, error: '还没有选定项目。' }
  }
  let next = state
  for (const change of changes) {
    try {
      const result = await client.changeSettings(projectRoot, change)
      next = { ...next, snapshot: result.settings, error: undefined }
    } catch (error) {
      return { ...next, busy: false, error: messageOf(error) }
    }
  }
  return { ...next, busy: false }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
