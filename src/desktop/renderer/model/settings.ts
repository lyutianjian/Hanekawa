import {
  CONTEXT_MANAGEMENT_FIELDS,
  type SettingsCategory,
  type SettingsChange,
  type WireAgentDefinitionInfo,
  type WireContextManagementField,
  type WireEndpointInfo,
  type WireMcpServerInfo,
  type WireSkillInfo,
  type WireModelInfo,
  type WirePermissionGroup,
  type WireSettingsSnapshot,
  type WireShellSettingsChangeResult,
  type WireShellSettingsResult,
} from '../../shellProtocol.js'
import { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCES, type ThemePreference } from './theme.js'

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
 * The host categories are live via `cardsFor`, a `switch` with no `default`, so a
 * fifth host category cannot be added without building it — a stronger guard than
 * the list of "live" categories this replaced, which only failed at runtime and
 * only by drawing a disabled row. `appearance` is renderer-local (theme only, no
 * host data): `settingsView` returns its card before the snapshot guard, and
 * `cardsFor` is narrowed to `HostCategory` so it stays exhaustive without it.
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
      /**
       * The first model, offered only when the endpoint is new.
       *
       * An endpoint on its own routes nothing — every model names one — so
       * creating them separately made the useful act two forms long. Both empty
       * means "just the endpoint"; both filled adds the model in the same submit.
       */
      readonly modelKey: string
      readonly modelId: string
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
      /** `'on'` or `''` — a form field is a string, like every other one here. */
      readonly longContext1m: string
      readonly maxOutputTokens: string
    }
  | {
      readonly kind: 'permission-rule'
      readonly behavior: PermissionBehavior
      readonly entry: string
    }

/**
 * One change that has been sent and not yet answered.
 *
 * Held so the screen can draw the *outcome* immediately instead of the state
 * the host still has. Deleting a model used to leave its row on screen for a
 * whole round trip — a save, a settings reload and a runtime rebuild per open
 * lane — which reads as "the click did nothing" and invites a second one.
 */
export interface PendingMutation {
  /** Monotonic per screen; `runSettingsChanges` retires entries by it. */
  readonly id: number
  readonly change: SettingsChange
}

export interface SettingsState {
  readonly open: boolean
  readonly category: SettingsCategory
  /** A command is in flight; the screen keeps drawing and still takes input. */
  readonly busy: boolean
  /** Sent, unanswered, and already drawn. See {@link PendingMutation}. */
  readonly pending: readonly PendingMutation[]
  /** Mints `PendingMutation.id`, so the reducer stays a pure function. */
  readonly pendingSeq: number
  readonly projectRoot?: string
  readonly snapshot?: WireSettingsSnapshot
  readonly projects: ReadonlyArray<{ projectRoot: string; projectName: string }>
  readonly draft?: SettingsDraft
  readonly confirmingRemove?: { readonly kind: 'endpoint' | 'model'; readonly name: string }
  readonly error?: string
  /** Renderer-local theme preference; `app.ts` seeds it from `localStorage`. */
  readonly themePref: ThemePreference
  /** The search box. Filters the nav and the selected page; never the wire. */
  readonly query: string
  /**
   * Which pill dropdown is expanded, keyed by the DOM. At most one: two open
   * menus can overlap, and the screen has a dozen selects on it at once.
   */
  readonly openMenu?: string
}

export function createSettingsState(): SettingsState {
  return {
    open: false,
    category: 'provider',
    busy: false,
    pending: [],
    pendingSeq: 0,
    projects: [],
    themePref: DEFAULT_THEME_PREFERENCE,
    query: '',
  }
}

export const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  provider: '模型与服务商',
  extensions: '技能和 MCP',
  permissions: '权限',
  agent: 'Agent',
  general: '通用',
  appearance: '外观',
}

/** The `inherit` sentinel, spelled once. */
export const INHERIT = 'inherit'

export type SettingsGroup = 'personal' | 'integration' | 'coding'

export const SETTINGS_GROUP_ORDER: readonly SettingsGroup[] = ['personal', 'integration', 'coding']

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  personal: '个人',
  integration: '集成',
  coding: '编码',
}

/**
 * Exhaustive by construction: a sixth category cannot compile without a group.
 *
 * Deliberately over `SettingsCategory` and not `HostCategory` — `appearance` is
 * renderer-local but it is still a page in the nav, so it still needs a section.
 */
function groupOf(category: SettingsCategory): SettingsGroup {
  switch (category) {
    case 'general':
    case 'appearance':
      return 'personal'
    case 'provider':
    case 'extensions':
      return 'integration'
    case 'permissions':
    case 'agent':
      return 'coding'
  }
}

export type PermissionBehavior = WirePermissionGroup['behavior']

const BEHAVIOR_LABELS: Record<PermissionBehavior, string> = {
  allow: '自动允许',
  ask: '每次询问',
  deny: '始终拒绝',
}

// --- view model --------------------------------------------------------------

export interface SettingsNavItem {
  readonly category: SettingsCategory
  readonly label: string
  readonly selected: boolean
  readonly group: SettingsGroup
}

/** One section of the nav column. A section with no items is not produced. */
export interface SettingsNavGroup {
  readonly group: SettingsGroup
  readonly label: string
  readonly items: readonly SettingsNavItem[]
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
  /** A switch. `disabled` is for a setting this layer genuinely cannot change. */
  | {
      readonly kind: 'toggle'
      readonly value: boolean
      readonly disabled?: boolean
      readonly intentOnChange: (value: boolean) => SettingsIntent
    }
  /**
   * A single-line field that commits on blur or Enter, never per keystroke: a
   * keystroke-level commit would write the config once per character typed.
   */
  | {
      readonly kind: 'input'
      readonly value: string
      readonly placeholder?: string
      readonly mono?: boolean
      readonly intentOnCommit: (value: string) => SettingsIntent
    }
  | { readonly kind: 'buttons'; readonly buttons: readonly SettingsButton[] }

export interface SettingsButton {
  readonly label: string
  readonly title: string
  readonly intent: SettingsIntent
  readonly danger?: boolean
  readonly icon?: 'trash' | 'plus' | 'folder'
  /**
   * The wire change this button starts, for the action buttons in a card footer.
   *
   * Only so `markPending` can tell that *this* button is the one waiting: an
   * action leaves no row behind to dim, so the button is the whole feedback.
   */
  readonly changeKind?: SettingsChange['kind']
  /** Set by `markPending`: the change this button sent has not answered yet. */
  readonly pending?: boolean
}

export interface SettingsRow {
  readonly id: string
  readonly label: string
  readonly detail?: string
  /** Drawn in the accent-warning colour: the row is configured but unusable. */
  readonly warning?: string
  readonly control: SettingsControl
  /** A change about this row is in flight; the view dims it and stops its controls. */
  readonly pending?: boolean
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

/**
 * Where a form or a confirmation is drawn.
 *
 * Both used to be stacked at the top of the column, above every card. That put
 * 「新增模型」's form off-screen for anyone who had scrolled down to the button
 * that opened it — the screen answered a click somewhere the user was not
 * looking. An anchor names the card that owns it, and a row when there is one:
 * an edit belongs directly under the thing being edited.
 */
export interface SettingsAnchor {
  readonly cardId: string
  readonly rowId?: string
}

export interface SettingsForm {
  readonly title: string
  readonly fields: readonly SettingsFormField[]
  readonly submitLabel: string
  readonly anchor: SettingsAnchor
}

export interface SettingsViewModel {
  readonly open: boolean
  readonly navGroups: readonly SettingsNavGroup[]
  readonly title: string
  readonly subtitle?: string
  readonly cards: readonly SettingsCard[]
  readonly form?: SettingsForm
  readonly error?: string
  readonly busy: boolean
  readonly projectChoices: ReadonlyArray<{ value: string; label: string }>
  readonly projectValue: string
  readonly confirming?: { readonly message: string; readonly anchor: SettingsAnchor }
  /** Echoed back so the DOM can tell "the model cleared it" from "the user typed". */
  readonly query: string
  /** Set only when a non-empty query filtered the page down to nothing. */
  readonly searchEmpty?: string
  /** The expanded pill dropdown's key, as the DOM spells it. */
  readonly openMenu?: string
}

const ALL_CATEGORIES: readonly SettingsCategory[] = [
  'provider',
  'extensions',
  'permissions',
  'agent',
  'general',
  'appearance',
]

/**
 * The nav column, grouped. `keep` is the search filter; step-order matters only
 * in that the *item* order inside a section stays `ALL_CATEGORIES` order, so a
 * query cannot shuffle the list under the pointer.
 */
function navGroupsFor(
  state: SettingsState,
  keep: (category: SettingsCategory) => boolean,
): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = []
  for (const group of SETTINGS_GROUP_ORDER) {
    const items = ALL_CATEGORIES.filter(
      (category) => groupOf(category) === group && keep(category),
    ).map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      selected: state.category === category,
      group,
    }))
    if (items.length > 0) groups.push({ group, label: SETTINGS_GROUP_LABELS[group], items })
  }
  return groups
}

/**
 * Case-insensitive, trimmed substring match against the text that is *on screen*.
 *
 * An empty query matches everything, so callers can pass `state.query` straight
 * through rather than each remembering to special-case it.
 */
export function matchesQuery(query: string, ...haystack: ReadonlyArray<string | undefined>): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return haystack.some((text) => text !== undefined && text.toLowerCase().includes(needle))
}

/** A card matches on its own text, or through any of its rows. */
function cardMatches(card: SettingsCard, query: string): boolean {
  if (matchesQuery(query, card.title, card.note)) return true
  return card.rows.some((row) => matchesQuery(query, row.label, row.detail))
}

/**
 * Whether a *page* has anything to show for the query: its nav label, or any of
 * its cards. `appearance` is renderer-local, so it can answer with no snapshot;
 * the four host pages fall back to label-only until one is loaded.
 */
function categoryMatches(category: SettingsCategory, state: SettingsState, query: string): boolean {
  if (matchesQuery(query, CATEGORY_LABELS[category])) return true
  const cards =
    category === 'appearance'
      ? appearanceCards(state.themePref)
      : state.snapshot
        ? cardsFor(category, state.snapshot)
        : []
  return cards.some((card) => cardMatches(card, query))
}

/**
 * The body-side filter. A card that matched on its own title keeps *all* of its
 * rows — searching 「MCP」 should show the server list, not an empty MCP card.
 */
function filterCards(
  cards: readonly SettingsCard[],
  query: string,
): { cards: SettingsCard[]; searchEmpty?: string } {
  if (query.trim() === '') return { cards: [...cards] }
  const kept: SettingsCard[] = []
  for (const card of cards) {
    if (matchesQuery(query, card.title, card.note)) {
      kept.push(card)
      continue
    }
    const rows = card.rows.filter((row) => matchesQuery(query, row.label, row.detail))
    if (rows.length > 0) kept.push({ ...card, rows })
  }
  if (kept.length > 0) return { cards: kept }
  return { cards: kept, searchEmpty: `没有匹配「${query.trim()}」的设置。` }
}

// --- the optimistic projection -----------------------------------------------

/**
 * The snapshot as it will be once the pending changes land.
 *
 * The screen draws *this*, never `state.snapshot`, so a click shows its own
 * result on the next paint instead of after a round trip. Nothing here writes
 * anything: a failure simply retires the mutation and the real snapshot — which
 * was never modified — comes back, so the rollback costs nothing.
 *
 * Only the variants whose effect is visible on this screen are folded. The
 * actions (`reload-skills`, `reconnect-mcp`, `import-skill`, …) change nothing
 * that can be predicted, so they project to themselves and are drawn instead by
 * {@link pendingKinds} disabling the button that started them.
 */
export function projectSnapshot(
  snapshot: WireSettingsSnapshot,
  pending: readonly PendingMutation[],
): WireSettingsSnapshot {
  let next = snapshot
  for (const { change } of pending) next = projectOne(next, change)
  return next
}

function projectOne(snapshot: WireSettingsSnapshot, change: SettingsChange): WireSettingsSnapshot {
  switch (change.kind) {
    case 'remove-endpoint':
      // The cascade the config performs: an endpoint takes its models with it.
      return withDefaultRepaired({
        ...snapshot,
        endpoints: snapshot.endpoints.filter((endpoint) => endpoint.name !== change.name),
        models: snapshot.models.filter((model) => model.endpoint !== change.name),
      })
    case 'remove-model':
      return withDefaultRepaired({
        ...snapshot,
        models: snapshot.models.filter((model) => model.key !== change.key),
      })
    case 'rename-model':
      return {
        ...snapshot,
        models: snapshot.models.map((model) =>
          model.key === change.from ? { ...model, key: change.to } : model,
        ),
        ...(snapshot.defaultModel === change.from ? { defaultModel: change.to } : {}),
      }
    case 'set-endpoint': {
      const row: WireEndpointInfo = {
        name: change.name,
        provider: change.provider,
        ...(change.baseUrl !== undefined ? { baseUrl: change.baseUrl } : {}),
        // The mask is the host's to compute; until it answers, a row that is
        // *being* created says nothing rather than guessing at a key.
        ...(existingEndpoint(snapshot, change.name)?.apiKeyMasked !== undefined
          ? { apiKeyMasked: existingEndpoint(snapshot, change.name)!.apiKeyMasked }
          : {}),
      }
      return { ...snapshot, endpoints: upsert(snapshot.endpoints, row, (item) => item.name) }
    }
    case 'set-model': {
      const row: WireModelInfo = {
        key: change.key,
        model: change.model,
        ...(change.endpoint !== undefined ? { endpoint: change.endpoint } : {}),
        ...(change.provider !== undefined ? { provider: change.provider } : {}),
        ...(change.contextWindow !== undefined ? { contextWindow: change.contextWindow } : {}),
        ...(change.longContext1m !== undefined ? { longContext1m: change.longContext1m } : {}),
        ...(change.maxOutputTokens !== undefined ? { maxOutputTokens: change.maxOutputTokens } : {}),
        // Optimistic on purpose: the host answers with the truth a moment later,
        // and drawing 「无法解析」 on a model the user just typed would be a
        // warning about nothing.
        resolves: true,
      }
      return { ...snapshot, models: upsert(snapshot.models, row, (item) => item.key) }
    }
    case 'set-default-model':
      return { ...snapshot, defaultModel: change.key }
    case 'set-routing':
      return { ...snapshot, routing: { ...snapshot.routing, [change.role]: change.value } }
    case 'set-subagent-routing':
      return {
        ...snapshot,
        routing: {
          ...snapshot.routing,
          subagent: snapshot.routing.subagent.map((entry) =>
            entry.type === change.type ? { ...entry, value: change.value } : entry,
          ),
        },
        agents: snapshot.agents.map((agent) =>
          agent.type === change.type ? { ...agent, routing: change.value } : agent,
        ),
      }
    case 'set-skill-enabled':
      return {
        ...snapshot,
        skills: snapshot.skills.map((skill) =>
          skill.name === change.name ? { ...skill, enabled: change.enabled } : skill,
        ),
      }
    case 'set-mcp-trust':
      return {
        ...snapshot,
        mcpServers: snapshot.mcpServers.map((server) =>
          server.name === change.name ? { ...server, trusted: change.trusted } : server,
        ),
      }
    case 'set-context-management':
      return {
        ...snapshot,
        contextManagement: { ...snapshot.contextManagement, [change.field]: change.value },
      }
    case 'set-permission-entries':
      return {
        ...snapshot,
        permissions: {
          ...snapshot.permissions,
          groups: snapshot.permissions.groups.map((group) =>
            group.behavior === change.behavior ? { ...group, local: [...change.entries] } : group,
          ),
        },
      }
    case 'set-startup-permission-mode':
      return { ...snapshot, permissions: { ...snapshot.permissions, mode: change.mode } }
    case 'set-cache-ttl':
      return { ...snapshot, general: { ...snapshot.general, cacheTtl1h: change.enabled } }
    case 'set-thinking':
      return { ...snapshot, general: { ...snapshot.general, thinking: change.enabled } }
    // Actions and the key clear: nothing on screen can be predicted from them.
    case 'clear-endpoint-key':
    case 'reload-agent-definitions':
    case 'reload-skills':
    case 'import-skill':
    case 'reconnect-mcp':
      return snapshot
  }
}

function existingEndpoint(
  snapshot: WireSettingsSnapshot,
  name: string,
): WireEndpointInfo | undefined {
  return snapshot.endpoints.find((endpoint) => endpoint.name === name)
}

/** Replaces the row with the same key, or appends it — the shape both cards need. */
function upsert<T>(rows: readonly T[], row: T, keyOf: (row: T) => string): T[] {
  const at = rows.findIndex((candidate) => keyOf(candidate) === keyOf(row))
  if (at === -1) return [...rows, row]
  const next = [...rows]
  next[at] = row
  return next
}

/**
 * The promotion `ConfigService.removeModel` performs: a `defaultModel` naming a
 * model that is gone moves to the first one still configured, or disappears.
 */
function withDefaultRepaired(snapshot: WireSettingsSnapshot): WireSettingsSnapshot {
  if (snapshot.defaultModel === undefined) return snapshot
  if (snapshot.models.some((model) => model.key === snapshot.defaultModel)) return snapshot
  const successor = snapshot.models[0]?.key
  if (successor === undefined) {
    const { defaultModel: _gone, ...rest } = snapshot
    return rest
  }
  return { ...snapshot, defaultModel: successor }
}

/**
 * The rows a pending change is *about*, so the view can mark them in flight.
 *
 * Removals are absent on purpose: their row is already gone from the projection,
 * and there is nothing left to mark.
 */
export function pendingRowIds(pending: readonly PendingMutation[]): Set<string> {
  const ids = new Set<string>()
  for (const { change } of pending) {
    switch (change.kind) {
      case 'set-endpoint':
      case 'clear-endpoint-key':
        ids.add(`endpoint:${change.name}`)
        break
      case 'set-model':
      case 'set-default-model':
        ids.add(`model:${change.key}`)
        break
      case 'rename-model':
        ids.add(`model:${change.to}`)
        break
      case 'set-routing':
        ids.add(`routing:${change.role}`)
        break
      case 'set-subagent-routing':
        ids.add(`routing:subagent:${change.type}`)
        ids.add(`agent:${change.type}`)
        break
      case 'set-skill-enabled':
        ids.add(`skill:${change.name}`)
        break
      case 'set-mcp-trust':
        ids.add(`mcp:${change.name}`)
        break
      case 'set-context-management':
        ids.add(`context:${change.field}`)
        break
      case 'set-startup-permission-mode':
        ids.add('permissions:mode')
        break
      case 'set-cache-ttl':
        ids.add('general:cache-ttl')
        break
      case 'set-thinking':
        ids.add('general:thinking')
        break
      default:
        break
    }
  }
  return ids
}

/** The change kinds in flight, so the footer button that started one can wait. */
export function pendingKinds(pending: readonly PendingMutation[]): Set<SettingsChange['kind']> {
  return new Set(pending.map((entry) => entry.change.kind))
}

export function settingsView(state: SettingsState): SettingsViewModel {
  const searching = state.query.trim() !== ''
  const base = {
    open: state.open,
    // The selected page is never filtered out: the nav therefore cannot go empty
    // and the user cannot lose their place, which is also why there is no
    // "no matching pages" empty state in the nav column.
    navGroups: navGroupsFor(state, (category) =>
      !searching || category === state.category || categoryMatches(category, state, state.query),
    ),
    busy: state.busy,
    query: state.query,
    projectChoices: state.projects.map((project) => ({
      value: project.projectRoot,
      label: project.projectName,
    })),
    projectValue: state.projectRoot ?? '',
    ...(state.openMenu !== undefined ? { openMenu: state.openMenu } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.confirmingRemove && state.snapshot
      ? {
          confirming: {
            message: removeConfirmMessage(state.confirmingRemove, state.snapshot),
            anchor: confirmAnchor(state.confirmingRemove),
          },
        }
      : {}),
  }

  // Theme is renderer-local: no host data, so draw it before the snapshot guard
  // (a project need not be loaded to change the theme). Narrows `state.category`
  // to `HostCategory` for the calls below.
  if (state.category === 'appearance') {
    return {
      ...base,
      title: CATEGORY_LABELS.appearance,
      ...filterCards(appearanceCards(state.themePref), state.query),
    }
  }

  // No `searchEmpty` here on purpose: 「还没有加载」 and 「没有匹配」 are different
  // facts, and the screen must not claim the second when the cause is the first.
  if (!state.snapshot) {
    return { ...base, title: CATEGORY_LABELS[state.category], cards: [] }
  }

  // The *projected* snapshot everywhere below, never `state.snapshot`: a click
  // draws its own outcome now and the host confirms it a round trip later.
  const projected = projectSnapshot(state.snapshot, state.pending)
  const cards = markPending(
    cardsFor(state.category, projected),
    pendingRowIds(state.pending),
    pendingKinds(state.pending),
  )

  return {
    ...base,
    title: CATEGORY_LABELS[state.category],
    // Only the provider page has one file to name for the whole page; the other
    // three mix `config.json` with `settings.local.json`, so those say it per card.
    ...(state.category === 'provider' ? { subtitle: `配置写入 ${projected.saveTarget}` } : {}),
    ...filterCards(cards, state.query),
    ...(state.draft ? { form: draftForm(state.draft, projected) } : {}),
  }
}

/**
 * Marks the rows and buttons a pending change is about.
 *
 * A pending row is drawn and dimmed rather than removed: unlike a deletion, a
 * toggle or an edit still has something to show, and taking the row away for the
 * length of a round trip would be a worse flicker than the lag it replaces.
 */
function markPending(
  cards: readonly SettingsCard[],
  rowIds: ReadonlySet<string>,
  kinds: ReadonlySet<SettingsChange['kind']>,
): SettingsCard[] {
  if (rowIds.size === 0 && kinds.size === 0) return [...cards]
  return cards.map((card) => ({
    ...card,
    rows: card.rows.map((row) => (rowIds.has(row.id) ? { ...row, pending: true } : row)),
    ...(card.footerButtons
      ? {
          footerButtons: card.footerButtons.map((button) =>
            button.changeKind !== undefined && kinds.has(button.changeKind)
              ? { ...button, pending: true }
              : button,
          ),
        }
      : {}),
  }))
}

/** The host-backed categories: everything except renderer-local `appearance`. */
type HostCategory = Exclude<SettingsCategory, 'appearance'>

/** Exhaustive by construction: a new host category cannot compile without cards. */
function cardsFor(category: HostCategory, snapshot: WireSettingsSnapshot): SettingsCard[] {
  switch (category) {
    case 'provider':
      return providerCards(snapshot)
    case 'extensions':
      return extensionsCards(snapshot)
    case 'permissions':
      return permissionCards(snapshot)
    case 'agent':
      return agentCards(snapshot)
    case 'general':
      return generalCards(snapshot)
  }
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
}

/** Junk from the DOM `<select>` narrows back to the union. */
function asThemePreference(value: string): ThemePreference {
  return value === 'dark' || value === 'light' ? value : 'system'
}

function appearanceCards(pref: ThemePreference): SettingsCard[] {
  return [
    {
      id: 'appearance',
      title: '主题',
      note: '主题只保存在本机，不写入项目配置。',
      rows: [
        {
          id: 'appearance:theme',
          label: '界面主题',
          detail: '跟随系统时，会随系统深浅色自动切换。',
          control: {
            kind: 'select',
            value: pref,
            choices: THEME_PREFERENCES.map((value) => ({ value, label: THEME_LABELS[value] })),
            intentOnChange: (value: string): SettingsIntent => ({
              kind: 'set-theme',
              preference: asThemePreference(value),
            }),
          },
        },
      ],
    },
  ]
}

/**
 * The question, with the cascade spelled out.
 *
 * Removing an endpoint takes its models with it now, so the confirmation names
 * them: a cascade the user is not told about is a data loss they find out about
 * afterwards. Read off the snapshot, which already carries each model's endpoint
 * — no wire field was added for this.
 */
function removeConfirmMessage(
  target: { kind: 'endpoint' | 'model'; name: string },
  snapshot: WireSettingsSnapshot,
): string {
  if (target.kind === 'model') return `删除模型 ${target.name}？`
  const cascade = snapshot.models
    .filter((model) => model.endpoint === target.name)
    .map((model) => model.key)
  if (cascade.length === 0) return `删除服务商 ${target.name}？`
  return `删除服务商 ${target.name}？将同时删除模型 ${cascade.join('、')}。`
}

function confirmAnchor(target: { kind: 'endpoint' | 'model'; name: string }): SettingsAnchor {
  return target.kind === 'endpoint'
    ? { cardId: 'endpoints', rowId: `endpoint:${target.name}` }
    : { cardId: 'models', rowId: `model:${target.name}` }
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
  if (model.longContext1m) parts.push('1M 请求头')
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

// --- permissions --------------------------------------------------------------

const BEHAVIOR_NOTES: Record<PermissionBehavior, string> = {
  allow: '匹配到的工具调用不再提示。',
  ask: '匹配到的工具调用一定提示，即使处于自动接受模式。',
  deny: '匹配到的工具调用直接拒绝，bypass 模式也不例外。',
}

const PERMISSION_MODE_LABELS: Record<'default' | 'acceptEdits' | 'bypass', string> = {
  default: 'default（按规则提示）',
  acceptEdits: 'acceptEdits（自动接受文件编辑）',
  bypass: 'bypass（跳过提示，仍然遵守拒绝规则）',
}

/**
 * `default` for anything else.
 *
 * The select only ever offers the three, so this is unreachable — but it is what
 * keeps the intent's `mode` a union without a cast, and it mirrors the same
 * narrowing the host does on the way out.
 */
function asStartupMode(value: string): 'default' | 'acceptEdits' | 'bypass' {
  return value === 'acceptEdits' || value === 'bypass' ? value : 'default'
}

function permissionCards(snapshot: WireSettingsSnapshot): SettingsCard[] {
  const { permissions } = snapshot
  const modeCard: SettingsCard = {
    id: 'permission-mode',
    title: '默认权限模式',
    note: permissions.modeIsLocal
      ? `写入 ${permissions.localPath}`
      : `当前值来自上层设置文件；改动写入 ${permissions.localPath}`,
    rows: [
      {
        id: 'permissions:mode',
        label: '新会话的起始模式',
        // Not a hedge: the gate reads this when a scope is built, so an open
        // session keeps the mode it opened with — including one the user has
        // since toggled by hand, which this must not fight over.
        detail: '对已经打开的会话无效，下一个新会话生效。',
        control: {
          kind: 'select',
          value: permissions.mode,
          choices: (['default', 'acceptEdits', 'bypass'] as const).map((mode) => ({
            value: mode,
            label: PERMISSION_MODE_LABELS[mode],
          })),
          intentOnChange: (value: string): SettingsIntent => ({
            kind: 'set-startup-permission-mode',
            mode: asStartupMode(value),
          }),
        },
      },
    ],
  }
  return [modeCard, ...permissions.groups.map((group) => permissionGroupCard(group, permissions.localPath))]
}

/**
 * One behaviour's rules, local ones first.
 *
 * Inherited rules are drawn and labelled rather than hidden: they are being
 * enforced, so a screen that showed only the editable ones would explain
 * neither why a tool is denied nor why removing the rule you *can* see changed
 * nothing.
 */
function permissionGroupCard(group: WirePermissionGroup, localPath: string): SettingsCard {
  const local: SettingsRow[] = group.local.map((entry, index) => ({
    // The index is in the id because the same literal may legitimately be listed
    // twice, and two rows with one id is a DOM bug waiting for a keyed update.
    id: `permission:${group.behavior}:local:${index}`,
    label: entry,
    control: {
      kind: 'buttons' as const,
      buttons: [
        {
          label: '',
          title: `删除 ${entry}`,
          icon: 'trash' as const,
          danger: true,
          intent: {
            kind: 'remove-permission-rule',
            behavior: group.behavior,
            entry,
          } as SettingsIntent,
        },
      ],
    },
  }))
  const inherited: SettingsRow[] = group.inherited.map((entry, index) => ({
    id: `permission:${group.behavior}:inherited:${index}`,
    label: entry,
    detail: '来自上层设置文件，只能在那里改。',
    control: { kind: 'text' as const, value: '继承', muted: true },
  }))
  return {
    id: `permissions:${group.behavior}`,
    title: BEHAVIOR_LABELS[group.behavior],
    note: `${BEHAVIOR_NOTES[group.behavior]}本地规则写入 ${localPath}`,
    empty: '还没有规则。',
    rows: [...local, ...inherited],
    footerButtons: [
      {
        label: '新增规则',
        title: `新增${BEHAVIOR_LABELS[group.behavior]}规则`,
        icon: 'plus',
        intent: { kind: 'new-permission-rule', behavior: group.behavior },
      },
    ],
  }
}

// --- agents -------------------------------------------------------------------

function agentCards(snapshot: WireSettingsSnapshot): SettingsCard[] {
  const choices = routingOptions(snapshot)
  return [
    {
      id: 'agents',
      title: '子 agent',
      note: `定义来自 .myagent/agents/ 下的 md 文件，这里只读；路由写入 ${snapshot.saveTarget}`,
      empty: '没有可用的子 agent 定义。',
      rows: snapshot.agents.map((agent) => ({
        id: `agent:${agent.type}`,
        label: agent.type,
        detail: agentDetail(agent),
        control: {
          kind: 'select' as const,
          value: agent.routing,
          choices,
          intentOnChange: (value: string): SettingsIntent => ({
            kind: 'set-subagent-routing',
            type: agent.type,
            value,
          }),
        },
      })),
      footerButtons: [
        {
          label: '重新加载定义',
          title: '重新读取 .myagent/agents/，并让已开的会话用上新定义',
          intent: { kind: 'reload-agent-definitions' },
          changeKind: 'reload-agent-definitions',
        },
      ],
    },
  ]
}

function agentDetail(agent: WireAgentDefinitionInfo): string {
  const parts = [agent.builtIn ? '内置' : '自定义', agent.description]
  // Absent means every tool, which is the opposite of "no tools" — spelling it
  // out is the only way the row cannot be read backwards.
  parts.push(agent.tools ? `工具：${agent.tools.join('、')}` : '工具：全部')
  if (agent.permissionMode) parts.push(`权限模式：${agent.permissionMode}`)
  if (agent.model) parts.push(`模型：${agent.model}`)
  if (agent.isReadOnlyAgent) parts.push('只读')
  parts.push(`最多 ${agent.maxTurns} 轮`)
  return parts.join(' · ')
}

// --- general and the context budget -------------------------------------------

const CONTEXT_LABELS: Record<WireContextManagementField, string> = {
  contextWindow: '上下文窗口',
  summaryOutputTokens: '摘要输出上限',
  autoCompactBufferTokens: '自动压缩预留',
  manualCompactBufferTokens: '手动压缩预留',
  microCompactThresholdRatio: '微压缩触发比例',
  autoCompactThresholdRatio: '自动压缩触发比例',
}

const CONTEXT_DETAILS: Record<WireContextManagementField, string> = {
  contextWindow: '模型上下文窗口的 token 数。',
  summaryOutputTokens: '压缩摘要自身允许占用的输出 token。',
  autoCompactBufferTokens: '自动压缩时预留出来的空间。',
  manualCompactBufferTokens: '手动压缩时预留出来的空间。',
  microCompactThresholdRatio: '占用超过这个比例时开始微压缩。',
  autoCompactThresholdRatio: '占用超过这个比例时自动压缩。',
}

const CONTEXT_RATIO_FIELDS: readonly WireContextManagementField[] = [
  'microCompactThresholdRatio',
  'autoCompactThresholdRatio',
]

function generalCards(snapshot: WireSettingsSnapshot): SettingsCard[] {
  return [cacheCard(snapshot), contextCard(snapshot)]
}

function cacheCard(snapshot: WireSettingsSnapshot): SettingsCard {
  const { general } = snapshot
  return {
    id: 'general',
    title: '通用',
    note: `写入 ${general.localPath}`,
    rows: [
      {
        id: 'general:thinking',
        label: '扩展思考',
        detail:
          general.thinking === false
            ? '关闭：请求不带 thinking 参数，模型直接作答。'
            : '开启：模型按需思考，思考量由推理强度决定。',
        control: {
          kind: 'toggle',
          value: general.thinking !== false,
          intentOnChange: (enabled: boolean): SettingsIntent => ({ kind: 'set-thinking', enabled }),
        },
      },
      {
        id: 'general:cache-ttl',
        label: '1 小时提示词缓存',
        detail:
          general.cacheTtl1h === undefined
            ? '未设置：跟随环境变量 MYAGENT_PROMPT_CACHE_1H。'
            : '缓存的命中窗口更长，代价是写入更贵。',
        control: {
          kind: 'toggle',
          value: general.cacheTtl1h === true,
          intentOnChange: (enabled: boolean): SettingsIntent => ({ kind: 'set-cache-ttl', enabled }),
        },
      },
    ],
  }
}

// --- skills and MCP -----------------------------------------------------------

function extensionsCards(snapshot: WireSettingsSnapshot): SettingsCard[] {
  return [skillsCard(snapshot), mcpCard(snapshot)]
}

/**
 * The skills on disk, each with its switch.
 *
 * The switch is never `disabled`, unlike MCP trust: `skills.disabled` is
 * *replaced* by the settings merge rather than unioned, so the local layer can
 * always switch a skill back on — there is no "granted from above" state here.
 */
function skillsCard(snapshot: WireSettingsSnapshot): SettingsCard {
  return {
    id: 'skills',
    title: '技能',
    note: `定义来自 ${snapshot.skillsDir} 下的 SKILL.md，内容在这里只读；开关写入 settings.local.json`,
    empty: '还没有技能。可以从别处导入一个技能文件夹。',
    rows: snapshot.skills.map((skill) => ({
      id: `skill:${skill.name}`,
      label: `/${skill.name}`,
      detail: skillDetail(skill),
      control: {
        kind: 'toggle' as const,
        value: skill.enabled,
        intentOnChange: (enabled: boolean): SettingsIntent => ({
          kind: 'set-skill-enabled',
          name: skill.name,
          enabled,
        }),
      },
    })),
    footerButtons: [
      {
        label: '导入技能',
        title: '选择一个含 SKILL.md 的文件夹，复制进这个项目的 .myagent/skills/',
        icon: 'folder',
        intent: { kind: 'import-skill' },
        changeKind: 'import-skill',
      },
      {
        label: '重新加载技能',
        title: '重新读取 .myagent/skills/，并让已开的会话用上新定义',
        intent: { kind: 'reload-skills' },
        changeKind: 'reload-skills',
      },
    ],
  }
}

const SKILL_INCLUSION_LABELS: Record<WireSkillInfo['inclusion'], string> = {
  always: '总是加载',
  manual: '手动调用',
  fileMatch: '按文件匹配',
}

function skillDetail(skill: WireSkillInfo): string {
  const parts = [skill.description, SKILL_INCLUSION_LABELS[skill.inclusion]]
  if (skill.paths?.length) parts.push(`匹配 ${skill.paths.join('、')}`)
  // Absent means every tool, the same asymmetry `agentDetail` spells out.
  parts.push(skill.allowedTools ? `工具：${skill.allowedTools.join('、')}` : '工具：全部')
  if (skill.model) parts.push(`模型：${skill.model}`)
  if (skill.effort) parts.push(`推理强度：${skill.effort}`)
  if (skill.hasHooks) parts.push('带 hooks')
  if (skill.attachments) parts.push(`${skill.attachments} 个附件`)
  if (!skill.enabled) parts.push('已关闭：不进提示词，斜杠命令也不注册')
  return parts.join(' · ')
}

function mcpCard(snapshot: WireSettingsSnapshot): SettingsCard {
  return {
    id: 'mcp',
    title: 'MCP 服务器',
    note: '信任写入 settings.local.json。上层设置授予的信任在这里撤销不了——信任列表是跨层求并集的。',
    empty: '没有配置 MCP 服务器。',
    rows: snapshot.mcpServers.map((server) => ({
      id: `mcp:${server.name}`,
      label: server.name,
      detail: mcpDetail(server),
      // Only when trust is not the reason: an untrusted server "fails" with
      // `not trusted`, which the detail already explains as the next step.
      ...(server.trusted && server.status === 'failed' && server.error
        ? { warning: `连接失败：${server.error}` }
        : {}),
      control: {
        kind: 'toggle' as const,
        value: server.trusted,
        disabled: !server.trustEditable,
        intentOnChange: (trusted: boolean): SettingsIntent => ({
          kind: 'set-mcp-trust',
          name: server.name,
          trusted,
        }),
      },
    })),
    footerButtons: [
      {
        label: '重新连接',
        title: '关掉并重新连接所有 MCP 服务器',
        intent: { kind: 'reconnect-mcp' },
        changeKind: 'reconnect-mcp',
      },
    ],
  }
}

function mcpDetail(server: WireMcpServerInfo): string {
  const parts: string[] = [server.transport]
  if (server.target) parts.push(server.target)
  if (!server.trusted) parts.push('未信任：打开开关后会尝试连接')
  else if (server.status === 'connected') parts.push(`已连接 · ${server.toolCount ?? 0} 个工具`)
  else parts.push('未连接')
  return parts.join(' · ')
}

// --- the context budget -------------------------------------------------------

function contextCard(snapshot: WireSettingsSnapshot): SettingsCard {
  return {
    id: 'context',
    title: '上下文管理',
    // Not a disclaimer: the numbers are snapshotted into every session scope when
    // the project boots, so neither a settings reload nor a runtime rebuild can
    // reach a session that is already open.
    note: `写入 ${snapshot.saveTarget}；重启后生效——这些数值在项目启动时就读进了每个会话。`,
    rows: CONTEXT_MANAGEMENT_FIELDS.map((field) => ({
      id: `context:${field}`,
      label: CONTEXT_LABELS[field],
      detail: CONTEXT_DETAILS[field],
      control: {
        kind: 'input' as const,
        value: String(snapshot.contextManagement[field]),
        intentOnCommit: (value: string): SettingsIntent => ({
          kind: 'set-context-value',
          field,
          value,
        }),
      },
    })),
  }
}

/**
 * A typed context number, or the reason it is not one.
 *
 * Checked here as well as in `ConfigService` on purpose: the service throws, and
 * a throw becomes a `fail` reply the screen shows as a raw error. Catching it in
 * the reducer keeps a mistyped digit from looking like a broken host.
 */
function parseContextValue(
  field: WireContextManagementField,
  raw: string,
): number | { error: string } {
  const trimmed = raw.trim()
  const label = CONTEXT_LABELS[field]
  if (!trimmed) return { error: `${label}不能为空。` }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: `${label}必须是数字。` }
  if (CONTEXT_RATIO_FIELDS.includes(field)) {
    if (value <= 0 || value > 1) return { error: `${label}必须是 0 到 1 之间的比例。` }
    return value
  }
  if (!Number.isSafeInteger(value) || value < 1) return { error: `${label}必须是正整数。` }
  return value
}

// --- forms -------------------------------------------------------------------

function draftForm(draft: SettingsDraft, snapshot: WireSettingsSnapshot): SettingsForm {
  if (draft.kind === 'permission-rule') {
    return {
      title: `新增${BEHAVIOR_LABELS[draft.behavior]}规则`,
      submitLabel: '添加',
      anchor: { cardId: `permissions:${draft.behavior}` },
      fields: [
        {
          id: 'behavior',
          label: '行为',
          value: draft.behavior,
          choices: (['allow', 'ask', 'deny'] as const).map((behavior) => ({
            value: behavior,
            label: BEHAVIOR_LABELS[behavior],
          })),
        },
        {
          id: 'entry',
          label: '规则',
          value: draft.entry,
          mono: true,
          placeholder: '例如 Bash(git status:*)、Read 或 Write(src/**)',
        },
      ],
    }
  }
  if (draft.kind === 'endpoint') {
    return {
      title: draft.isNew ? '新增接入点' : `编辑接入点 ${draft.name}`,
      submitLabel: '保存',
      anchor: {
        cardId: 'endpoints',
        ...(draft.isNew ? {} : { rowId: `endpoint:${draft.name}` }),
      },
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
        // A new endpoint with no model is a row that cannot be used for anything,
        // so the first model is offered here rather than in a second trip through
        // 「新增模型」. Both fields or neither — see `draftToChanges`.
        ...(draft.isNew
          ? [
              {
                id: 'modelKey',
                label: '模型键名',
                value: draft.modelKey,
                placeholder: '可留空；例如 big',
              },
              {
                id: 'modelId',
                label: '模型 id',
                value: draft.modelId,
                mono: true,
                placeholder: '可留空；例如 claude-opus-5',
              },
            ]
          : []),
      ],
    }
  }
  return {
    title: draft.isNew ? '新增模型' : `编辑模型 ${draft.originalKey ?? draft.key}`,
    submitLabel: '保存',
    anchor: {
      cardId: 'models',
      ...(draft.originalKey === undefined ? {} : { rowId: `model:${draft.originalKey}` }),
    },
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
      {
        id: 'longContext1m',
        label: '1M 上下文请求头',
        value: draft.longContext1m,
        choices: [
          { value: '', label: '关闭' },
          { value: 'on', label: '开启：发送 context-1m beta' },
        ],
      },
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
  if (draft.kind === 'permission-rule') {
    const entry = draft.entry.trim()
    if (!entry) return { error: '规则不能为空。' }
    const local = localEntries(snapshot, draft.behavior)
    if (local.includes(entry)) {
      return { error: `${BEHAVIOR_LABELS[draft.behavior]}里已经有这条规则了。` }
    }
    // The whole group, local plus the new line: the host rewrites the local layer
    // outright, and sending only the new entry would drop every other one.
    return {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: draft.behavior,
      entries: [...local, entry],
    }
  }
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
  // Only written when on, so switching it off removes the field rather than
  // storing a `false` — the same shape an emptied `contextWindow` sends.
  if (draft.longContext1m === 'on') change.longContext1m = true
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

/** The editable half of one permission group. */
function localEntries(snapshot: WireSettingsSnapshot, behavior: PermissionBehavior): string[] {
  return [...(snapshot.permissions.groups.find((group) => group.behavior === behavior)?.local ?? [])]
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
  // A new endpoint may carry its first model. `runSettingsChanges` runs the
  // batch in order and folds each reply, so the `set-model` sees the endpoint.
  if (draft.kind === 'endpoint' && draft.isNew) {
    const modelKey = draft.modelKey.trim()
    const modelId = draft.modelId.trim()
    if (modelKey === '' && modelId === '') return [change]
    if (modelKey === '' || modelId === '') {
      return { error: '模型键名和模型 id 要么都填，要么都留空。' }
    }
    if (snapshot.models.some((model) => model.key === modelKey)) {
      return { error: `已经有一个叫 ${modelKey} 的模型。` }
    }
    return [
      change,
      { scope: 'provider', kind: 'set-model', key: modelKey, model: modelId, endpoint: draft.name.trim() },
      // Only when there is nothing to start from: a config that already names a
      // default must not have it moved by adding an endpoint.
      ...(snapshot.defaultModel === undefined
        ? [{ scope: 'provider', kind: 'set-default-model', key: modelKey } as SettingsChange]
        : []),
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
 * Escape unwinds one layer at a time, by visual nesting — the open dropdown,
 * then the form, then the delete confirmation, then the filtered list, then the
 * screen. The dropdown is innermost because a form field's menu is drawn *on top
 * of* the form, so dismissing it must not cost a half-typed form; the filter is
 * outermost-but-one because it is a state of the screen, and cancelling it must
 * not cost either of the layers inside it. Answers `'none'` for any modified key
 * so the global chords still get through.
 */
export function settingsKeyToIntent(chord: SettingsChord, state: SettingsState): SettingsIntent {
  if (chord.ctrlKey || chord.metaKey) return { kind: 'none' }
  if (chord.key === 'Escape') {
    if (state.openMenu !== undefined) return { kind: 'close-menu' }
    if (state.draft) return { kind: 'cancel-draft' }
    if (state.confirmingRemove) return { kind: 'cancel-remove' }
    if (state.query !== '') return { kind: 'clear-search' }
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
  | { kind: 'new-permission-rule'; behavior: PermissionBehavior }
  | { kind: 'remove-permission-rule'; behavior: PermissionBehavior; entry: string }
  | { kind: 'set-startup-permission-mode'; mode: 'default' | 'acceptEdits' | 'bypass' }
  | { kind: 'reload-agent-definitions' }
  | { kind: 'set-cache-ttl'; enabled: boolean }
  | { kind: 'set-thinking'; enabled: boolean }
  | { kind: 'set-context-value'; field: WireContextManagementField; value: string }
  | { kind: 'set-skill-enabled'; name: string; enabled: boolean }
  | { kind: 'reload-skills' }
  /** No path: the main process puts up the folder picker. */
  | { kind: 'import-skill' }
  | { kind: 'set-mcp-trust'; name: string; trusted: boolean }
  | { kind: 'reconnect-mcp' }
  | { kind: 'set-theme'; preference: ThemePreference }
  | { kind: 'search'; query: string }
  | { kind: 'clear-search' }
  | { kind: 'toggle-menu'; menu: string }
  /** Idempotent on purpose: focus loss and Escape both mean "closed", not "flipped". */
  | { kind: 'close-menu' }
  | { kind: 'none' }

export interface SettingsOutcome {
  readonly state: SettingsState
  /** Changes to send, in order. The caller runs them and folds the reply back. */
  readonly changes?: readonly SettingsChange[]
  /**
   * The same changes, already parked in `state.pending` and drawn.
   *
   * This is what the caller hands to {@link runSettingsChanges}, which retires
   * them by id as each reply lands. Separate from `changes` only because the ids
   * are minted here — the reducer stays pure, and nothing else has to know how
   * an optimistic row is identified.
   */
  readonly pending?: readonly PendingMutation[]
  /** The caller should (re)load the snapshot for `state.projectRoot`. */
  readonly load?: boolean
  /**
   * A renderer-local theme write. Never a `SettingsChange`: the theme has no host
   * config. `app.ts` persists it to `localStorage` and applies it to the document.
   */
  readonly themePreference?: ThemePreference
}

/**
 * The reducer. Exhaustive by `switch` over `intent.kind` with no `default`.
 *
 * Two rules hold across every branch: at most one form is open (opening a
 * second discards the first rather than stacking), and any transition that
 * changes what is on screen clears a stale error, so a failure message cannot
 * outlive the thing it was about.
 *
 * `cleared` also closes an open dropdown, which is what makes "picking a value
 * dismisses the menu" free: the intent a menu item emits is one of these.
 */
export function applySettingsIntent(state: SettingsState, intent: SettingsIntent): SettingsOutcome {
  const outcome = reduceSettingsIntent(state, intent)
  if (!outcome.changes || outcome.changes.length === 0) return outcome
  // One place, rather than a `pending` spread in each of the fifteen branches
  // that send something: every change the reducer emits is drawn optimistically,
  // with no exceptions to remember.
  const pending = outcome.changes.map((change, offset) => ({
    id: outcome.state.pendingSeq + offset,
    change,
  }))
  return {
    ...outcome,
    pending,
    state: {
      ...outcome.state,
      pending: [...outcome.state.pending, ...pending],
      pendingSeq: outcome.state.pendingSeq + pending.length,
    },
  }
}

function reduceSettingsIntent(state: SettingsState, intent: SettingsIntent): SettingsOutcome {
  const cleared = { ...state, error: undefined, confirmingRemove: undefined, openMenu: undefined }
  switch (intent.kind) {
    case 'none':
      return { state }
    case 'open':
      if (state.open) return { state }
      return { state: { ...cleared, open: true, draft: undefined, query: '' }, load: true }
    case 'close':
      return { state: { ...cleared, open: false, draft: undefined } }
    case 'select-category':
      return { state: { ...cleared, category: intent.category, draft: undefined } }
    // Typing is not a transition that invalidates what is on screen: it must not
    // dismiss an armed delete or a failure message, so neither uses `cleared`.
    // The dropdown does close — the row holding it can be filtered away.
    case 'search':
      return { state: { ...state, query: intent.query, openMenu: undefined } }
    case 'clear-search':
      return { state: { ...state, query: '', openMenu: undefined } }
    case 'toggle-menu':
      // Spreads `state`, not `cleared`: expanding a picker is not a reason to
      // discard an error the user has not read yet.
      return {
        state: { ...state, openMenu: state.openMenu === intent.menu ? undefined : intent.menu },
      }
    case 'close-menu':
      if (state.openMenu === undefined) return { state }
      return { state: { ...state, openMenu: undefined } }
    case 'set-theme':
      // Renderer-local: no wire change, no reload. `app.ts` performs the two side
      // effects (localStorage + document) off `themePreference`.
      return { state: { ...cleared, themePref: intent.preference }, themePreference: intent.preference }
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
            modelKey: '',
            modelId: '',
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
            // Not offered when editing: the form draws them only for `isNew`.
            modelKey: '',
            modelId: '',
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
            longContext1m: '',
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
            longContext1m: model.longContext1m ? 'on' : '',
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
      if ('error' in changes) return { state: { ...state, error: changes.error, openMenu: undefined } }
      return { state: { ...cleared, draft: undefined, busy: true }, changes }
    }

    case 'request-remove':
      return { state: { ...state, error: undefined, confirmingRemove: intent.target, openMenu: undefined } }
    case 'cancel-remove':
      return { state: { ...state, confirmingRemove: undefined, openMenu: undefined } }
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

    case 'new-permission-rule':
      return {
        state: {
          ...cleared,
          draft: { kind: 'permission-rule', behavior: intent.behavior, entry: '' },
        },
      }
    case 'remove-permission-rule': {
      if (!state.snapshot) return { state }
      const entries = localEntries(state.snapshot, intent.behavior)
      // By index, not by filter: the same literal can legitimately be listed
      // twice, and a filter would delete both when the user asked for one.
      const index = entries.indexOf(intent.entry)
      if (index === -1) return { state }
      entries.splice(index, 1)
      return {
        state: { ...cleared, busy: true },
        changes: [
          { scope: 'permissions', kind: 'set-permission-entries', behavior: intent.behavior, entries },
        ],
      }
    }
    case 'set-startup-permission-mode':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'permissions', kind: 'set-startup-permission-mode', mode: intent.mode }],
      }
    case 'reload-agent-definitions':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'agent', kind: 'reload-agent-definitions' }],
      }
    case 'set-cache-ttl':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'general', kind: 'set-cache-ttl', enabled: intent.enabled }],
      }
    case 'set-thinking':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'general', kind: 'set-thinking', enabled: intent.enabled }],
      }
    case 'set-context-value': {
      const parsed = parseContextValue(intent.field, intent.value)
      if (typeof parsed !== 'number') return { state: { ...state, error: parsed.error, openMenu: undefined } }
      return {
        state: { ...cleared, busy: true },
        changes: [
          { scope: 'general', kind: 'set-context-management', field: intent.field, value: parsed },
        ],
      }
    }
    case 'set-skill-enabled':
      return {
        state: { ...cleared, busy: true },
        changes: [
          { scope: 'extensions', kind: 'set-skill-enabled', name: intent.name, enabled: intent.enabled },
        ],
      }
    case 'reload-skills':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'extensions', kind: 'reload-skills' }],
      }
    case 'import-skill':
      // No `sourceDir`: the host owns the native picker, and a cancelled pick is
      // a successful no-op rather than an error.
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'extensions', kind: 'import-skill' }],
      }
    case 'set-mcp-trust':
      return {
        state: { ...cleared, busy: true },
        changes: [
          { scope: 'extensions', kind: 'set-mcp-trust', name: intent.name, trusted: intent.trusted },
        ],
      }
    case 'reconnect-mcp':
      return {
        state: { ...cleared, busy: true },
        changes: [{ scope: 'extensions', kind: 'reconnect-mcp' }],
      }
  }
}

function withField(draft: SettingsDraft, field: string, value: string): SettingsDraft {
  if (draft.kind === 'permission-rule') {
    switch (field) {
      case 'behavior':
        return value === 'allow' || value === 'ask' || value === 'deny'
          ? { ...draft, behavior: value }
          : draft
      case 'entry':
        return { ...draft, entry: value }
      default:
        return draft
    }
  }
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
      case 'modelKey':
        return { ...draft, modelKey: value }
      case 'modelId':
        return { ...draft, modelId: value }
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
    case 'longContext1m':
      return { ...draft, longContext1m: value }
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
  batch: readonly PendingMutation[],
): Promise<SettingsState> {
  const ids = new Set(batch.map((entry) => entry.id))
  // Retires this batch's optimistic rows whatever happens. On success the real
  // snapshot already says the same thing; on failure it says the old thing,
  // which *is* the rollback — nothing was ever written locally to undo.
  const retire = (from: SettingsState): SettingsState => ({
    ...from,
    pending: from.pending.filter((entry) => !ids.has(entry.id)),
  })

  const projectRoot = state.projectRoot
  if (projectRoot === undefined) {
    return { ...retire(state), busy: false, error: '还没有选定项目。' }
  }
  let next = state
  for (const { change } of batch) {
    try {
      const result = await client.changeSettings(projectRoot, change)
      next = { ...next, snapshot: result.settings, error: undefined }
    } catch (error) {
      return { ...retire(next), busy: false, error: messageOf(error) }
    }
  }
  return { ...retire(next), busy: false }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
