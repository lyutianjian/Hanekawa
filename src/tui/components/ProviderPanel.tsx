import { useEffect, useState } from 'react'
import { Box, Text, useInput, useStdout } from '../ink.js'
import { theme } from '../theme.js'
import { commandVisibleRows, CommandListItem, CommandPane, CommandTabs, getVisibleWindow, type CommandHint } from './CommandUI.js'
import type {
  Config,
  ModelConfig,
  ConfigService,
} from '../../config/service.js'
import type {
  Endpoint,
  Routing,
} from '../../config/routing.js'
import { pingEndpoint, type EndpointPingResult } from '../../config/endpointPing.js'
import { maskKey } from '../../config/maskKey.js'
import {
  isSupportedProviderName,
  SUPPORTED_PROVIDER_NAMES,
} from '../../config/providers/registry.js'
import type { ProviderConfigChangeScope } from '../../runtime/providerRuntime.js'

type Tab = 'endpoints' | 'models' | 'routing'
const TABS: readonly Tab[] = ['endpoints', 'models', 'routing']
const CONTEXT_WINDOW_OPTIONS: readonly string[] = ['(default)', '200K', '400K', '1M']

/**
 * What a routing role can be set to: inherit the main model, or any configured
 * model key. Derived from the live config rather than a constant, because with
 * tiers gone the choices *are* the user's models.
 */
function routingOptions(cfg: Config): readonly string[] {
  return ['inherit', ...Object.keys(cfg.models)]
}

function contextWindowToLabel(n: number | undefined): string {
  if (n === undefined) return '(default)'
  if (n === 200_000) return '200K'
  if (n === 400_000) return '400K'
  if (n === 1_000_000) return '1M'
  return String(n)
}

function contextWindowFromLabel(label: string): number | undefined {
  if (label === '(default)' || !label) return undefined
  if (label === '200K') return 200_000
  if (label === '400K') return 400_000
  if (label === '1M') return 1_000_000
  const n = Number(label)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

type FormState =
  | { kind: 'list' }
  | { kind: 'endpoint-edit'; nameInput: string; provider: string; baseUrl: string; apiKey: string; field: 'nameInput' | 'provider' | 'baseUrl' | 'apiKey'; cursor: number; original: string | null }
  | { kind: 'model-edit'; nameInput: string; modelId: string; endpointName: string; contextWindow: string; field: 'nameInput' | 'modelId' | 'endpointName' | 'contextWindow'; cursor: number; original: string | null }
  | { kind: 'routing-edit'; role: RoutingRoleKey; valueIndex: number }
  | { kind: 'confirm-delete'; what: string; targetId: string }
  | { kind: 'busy'; message: string }

type RoutingRoleKey =
  | 'main'
  | 'plan'
  | 'compact'
  | 'subagent.general'
  | 'subagent.fork'
  | 'subagent.explore'
  | 'subagent.plan'

const ROUTING_ROLES: readonly RoutingRoleKey[] = [
  'main',
  'plan',
  'compact',
  'subagent.general',
  'subagent.fork',
  'subagent.explore',
  'subagent.plan',
]

export interface ProviderPanelProps {
  config: ConfigService
  /** Notify the parent when config has been mutated and saved so cached views
   *  and the live model runtime can be refreshed immediately. */
  onChange: (scope: ProviderConfigChangeScope) => void | Promise<void>
  onClose: () => void
}

/**
 * Full-screen /provider panel.
 *
 * Layout: top tab bar -> body (list of items with selection) -> footer
 * keybinding hints. Edit/new flows render a small inline form on top of the
 * list view rather than navigating away.
 *
 * State machine: `tab` selects the data category; `selectedIndex` tracks
 * cursor within the current list; `form` holds optional modal state. All
 * write operations route through ConfigService helpers, then call save()
 * and onChange() so the rest of the TUI sees the new config on the next
 * request.
 */
export function ProviderPanel({ config, onChange, onClose }: ProviderPanelProps) {
  const [tab, setTab] = useState<Tab>('endpoints')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [form, setForm] = useState<FormState>({ kind: 'list' })
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [statusKind, setStatusKind] = useState<'info' | 'error' | 'success'>('info')
  const [pingResults, setPingResults] = useState<Record<string, EndpointPingResult>>({})
  const { stdout } = useStdout()

  // Items are recomputed on every render. config.get() returns the same Config
  // object reference even after mutations, so we cannot rely on referential
  // equality for memoization -- instead we accept the O(n) cost (n is small)
  // and let React re-render on form / tab / status changes that always
  // accompany config mutations.
  const cfg = config.get()
  const items = collectListItems(cfg, tab)
  const listWindow = getVisibleWindow(items.length, selectedIndex, commandVisibleRows(stdout.rows, 11, 10))
  const visibleItems = items.slice(listWindow.start, listWindow.end)

  // Clamp selectedIndex into the current items range. Without this, deleting
  // an item leaves selectedIndex pointing past the end and the cursor
  // visually disappears until the user moves it.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0)
      return
    }
    if (selectedIndex >= items.length) {
      setSelectedIndex(items.length - 1)
    }
  }, [items.length, selectedIndex])

  const flashStatus = (message: string, kind: 'info' | 'error' | 'success' = 'info') => {
    setStatusMessage(message)
    setStatusKind(kind)
  }

  const persist = async (mutation: () => void, successMessage?: string) => {
    setForm({ kind: 'busy', message: 'Saving...' })
    try {
      mutation()
      await config.save()
      await onChange(tab)
      // setForm below changes form-state references so React re-renders;
      // items are recomputed inline from the freshly mutated config.
      setForm({ kind: 'list' })
      if (successMessage) flashStatus(successMessage, 'success')
    } catch (error) {
      setForm({ kind: 'list' })
      flashStatus(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  // ---------- input routing ----------

  useInput((input, key) => {
    if (form.kind === 'busy') return

    // Forms own their own keystrokes; only Esc bubbles up to cancel.
    if (form.kind === 'endpoint-edit' || form.kind === 'model-edit') {
      handleFormInput(input, key)
      return
    }

    if (form.kind === 'routing-edit') {
      handleRoutingFormInput(input, key)
      return
    }

    if (form.kind === 'confirm-delete') {
      if (key.escape || input === 'n' || input === 'N') {
        setForm({ kind: 'list' })
        return
      }
      if (input === 'y' || input === 'Y') {
        confirmDelete()
      }
      return
    }

    // Top-level list view.
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.tab && !key.shift) {
      cycleTab(1)
      return
    }
    if (key.tab && key.shift) {
      cycleTab(-1)
      return
    }
    if (key.leftArrow) {
      cycleTab(-1)
      return
    }
    if (key.rightArrow) {
      cycleTab(1)
      return
    }
    if (key.upArrow) {
      setSelectedIndex((i) => moveBoundedIndex(i, items.length, -1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => moveBoundedIndex(i, items.length, 1))
      return
    }
    if (key.home) {
      setSelectedIndex(0)
      return
    }
    if (key.end) {
      setSelectedIndex(Math.max(0, items.length - 1))
      return
    }
    if (key.return) {
      handleEnter()
      return
    }
    if (input === 'n') {
      handleNew()
      return
    }
    if (input === 'e') {
      handleEdit()
      return
    }
    if (input === 'd') {
      handleDelete()
      return
    }
    if (input === 't' && tab === 'endpoints') {
      void handlePing()
      return
    }
  })

  function cycleTab(delta: number) {
    const idx = TABS.indexOf(tab)
    const next = TABS[moveCyclicIndex(idx, TABS.length, delta < 0 ? -1 : 1)] ?? 'endpoints'
    setTab(next)
    setSelectedIndex(0)
    setStatusMessage(null)
  }

  function handleEnter() {
    handleEdit()
  }

  function handleNew() {
    if (tab === 'endpoints') {
      setForm({
        kind: 'endpoint-edit',
        nameInput: '',
        provider: 'anthropic',
        baseUrl: '',
        apiKey: '',
        field: 'nameInput',
        cursor: 0,
        original: null,
      })
      return
    }
    if (tab === 'models') {
      const firstEndpoint = Object.keys(cfg.endpoints ?? {})[0] ?? ''
      if (!firstEndpoint) {
        flashStatus('Create an endpoint before adding a model', 'error')
        return
      }
      setForm({
        kind: 'model-edit',
        nameInput: '',
        modelId: '',
        endpointName: firstEndpoint,
        contextWindow: '(default)',
        field: 'nameInput',
        cursor: 0,
        original: null,
      })
      return
    }
  }

  function handleEdit() {
    const item = items[selectedIndex]
    if (!item) return
    if (tab === 'endpoints') {
      const ep = cfg.endpoints?.[item.id]
      if (!ep) return
      setForm({
        kind: 'endpoint-edit',
        nameInput: item.id,
        provider: ep.provider,
        baseUrl: ep.baseUrl ?? '',
        apiKey: ep.apiKey ?? '',
        field: 'baseUrl',
        cursor: (ep.baseUrl ?? '').length,
        original: item.id,
      })
      return
    }
    if (tab === 'models') {
      const m = cfg.models[item.id]
      if (!m) return
      setForm({
        kind: 'model-edit',
        nameInput: item.id,
        modelId: m.model,
        endpointName: m.endpoint ?? '',
        contextWindow: contextWindowToLabel(m.contextWindow),
        field: 'modelId',
        cursor: m.model.length,
        original: item.id,
      })
      return
    }
    if (tab === 'routing') {
      const role = ROUTING_ROLES[selectedIndex]
      if (!role) return
      const options = routingOptions(cfg)
      const current = currentRoutingValue(cfg, role)
      const valueIndex = Math.max(0, options.indexOf(current))
      setForm({ kind: 'routing-edit', role, valueIndex })
      return
    }
  }

  function handleDelete() {
    const item = items[selectedIndex]
    if (!item) return
    if (tab === 'endpoints' || tab === 'models') {
      setForm({ kind: 'confirm-delete', what: tab, targetId: item.id })
    }
  }

  function confirmDelete() {
    if (form.kind !== 'confirm-delete') return
    const targetId = form.targetId
    const what = form.what
    void persist(() => {
      if (what === 'endpoints') config.removeEndpoint(targetId)
      else if (what === 'models') config.removeModel(targetId)
    }, `Deleted ${what.slice(0, -1)} "${targetId}"`)
  }

  async function handlePing() {
    const item = items[selectedIndex]
    if (!item) return
    const ep = cfg.endpoints?.[item.id]
    if (!ep) return
    setForm({ kind: 'busy', message: `Pinging ${item.id}...` })
    try {
      const result = await pingEndpoint(ep)
      setPingResults((prev) => ({ ...prev, [item.id]: result }))
      flashStatus(
        `${item.id}: ${result.ok ? 'OK' : 'FAIL'} (${result.message}, ${result.durationMs}ms)`,
        result.ok ? 'success' : 'error',
      )
    } finally {
      setForm({ kind: 'list' })
    }
  }

  // ---------- form input handling ----------

  function handleFormInput(input: string, key: InkKey) {
    if (key.escape) {
      setForm({ kind: 'list' })
      return
    }
    if (form.kind === 'endpoint-edit') {
      handleEndpointFormInput(input, key)
    } else if (form.kind === 'model-edit') {
      handleModelFormInput(input, key)
    }
  }

  function handleEndpointFormInput(input: string, key: InkKey) {
    if (form.kind !== 'endpoint-edit') return
    const fields: Array<typeof form.field> = ['nameInput', 'provider', 'baseUrl', 'apiKey']
    if (key.tab) {
      const next = fields[moveCyclicIndex(fields.indexOf(form.field), fields.length, key.shift ? -1 : 1)]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1
      const next = fields[moveBoundedIndex(fields.indexOf(form.field), fields.length, direction)]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.return || isSaveKey(input, key)) {
      const name = form.nameInput.trim()
      if (!name) return flashStatus('Name is required', 'error')
      const provider = form.provider.trim()
      if (!isSupportedProviderName(provider)) {
        return flashStatus(`Unsupported provider "${provider}"`, 'error')
      }
      const endpoint: Endpoint = {
        provider,
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }
      const existing = cfg.endpoints?.[form.original ?? name]
      if (existing?.promptCaching !== undefined) endpoint.promptCaching = existing.promptCaching
      void persist(() => {
        if (form.original && form.original !== name) {
          config.removeEndpoint(form.original)
        }
        config.setEndpoint(name, endpoint)
      }, `Saved endpoint "${name}"`)
      return
    }
    if (form.field === 'provider') {
      const direction = choiceDirection(key)
      if (direction !== 0) {
        const provider = cycleChoiceValue(form.provider, SUPPORTED_PROVIDER_NAMES, direction)
        setForm({ ...form, provider, cursor: provider.length })
      }
      return
    }
    setForm(applyKeyToForm(form, input, key))
  }

  function handleModelFormInput(input: string, key: InkKey) {
    if (form.kind !== 'model-edit') return
    const fields: Array<typeof form.field> = ['nameInput', 'modelId', 'endpointName', 'contextWindow']
    if (key.tab) {
      const next = fields[moveCyclicIndex(fields.indexOf(form.field), fields.length, key.shift ? -1 : 1)]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1
      const next = fields[moveBoundedIndex(fields.indexOf(form.field), fields.length, direction)]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.return || isSaveKey(input, key)) {
      const name = form.nameInput.trim()
      if (!name) return flashStatus('Name is required', 'error')
      if (!form.modelId.trim()) return flashStatus('Model id is required', 'error')
      if (!form.endpointName.trim()) return flashStatus('Endpoint is required', 'error')
      if (form.endpointName.trim() && !cfg.endpoints?.[form.endpointName.trim()]) {
        return flashStatus(`Unknown endpoint "${form.endpointName}"`, 'error')
      }
      const selectedEndpoint = form.endpointName.trim()
        ? cfg.endpoints?.[form.endpointName.trim()]
        : undefined
      if (selectedEndpoint && !isSupportedProviderName(selectedEndpoint.provider)) {
        return flashStatus(
          `Endpoint "${form.endpointName}" uses unsupported provider "${selectedEndpoint.provider}"`,
          'error',
        )
      }
      const parsedContextWindow = contextWindowFromLabel(form.contextWindow)
      const model: ModelConfig = {
        model: form.modelId.trim(),
        endpoint: form.endpointName.trim(),
        ...(parsedContextWindow ? { contextWindow: parsedContextWindow } : {}),
      }
      const existing = cfg.models[form.original ?? name]
      if (existing?.promptCaching !== undefined) model.promptCaching = existing.promptCaching
      void persist(() => {
        if (form.original && form.original !== name) {
          config.renameModel(form.original, name)
        }
        config.setModelConfig(name, model)
      }, `Saved model "${name}"`)
      return
    }
    if (form.field === 'endpointName') {
      const direction = choiceDirection(key)
      if (direction !== 0) {
        const endpoints = Object.keys(cfg.endpoints ?? {})
        const endpointName = cycleChoiceValue(form.endpointName, endpoints, direction)
        setForm({ ...form, endpointName, cursor: endpointName.length })
      }
      return
    }
    if (form.field === 'contextWindow') {
      const direction = choiceDirection(key)
      if (direction !== 0) {
        const contextWindow = cycleChoiceValue(form.contextWindow, CONTEXT_WINDOW_OPTIONS, direction)
        setForm({ ...form, contextWindow, cursor: contextWindow.length })
      }
      return
    }
    setForm(applyKeyToForm(form, input, key))
  }

  function handleRoutingFormInput(input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean }) {
    if (form.kind !== 'routing-edit') return
    const options = routingOptions(cfg)
    if (key.escape) {
      setForm({ kind: 'list' })
      return
    }
    if (key.upArrow || key.leftArrow) {
      setForm({ ...form, valueIndex: (form.valueIndex - 1 + options.length) % options.length })
      return
    }
    if (key.downArrow || key.rightArrow) {
      setForm({ ...form, valueIndex: (form.valueIndex + 1) % options.length })
      return
    }
    if (key.return) {
      const value = options[form.valueIndex]
      if (value === undefined) return
      const role = form.role
      const next = applyRoutingChange(config.getRouting(), role, value)
      void persist(() => config.setRouting(next), `Routing ${role} -> ${value}`)
    }
  }

  // ---------- render ----------

  return (
    <CommandPane
      title="Provider configuration"
      subtitle="Manage endpoints, models, and request routing."
      hints={footerHints(tab, form)}
      status={statusMessage ? (
        <Text color={statusKind === 'error' ? theme.error : statusKind === 'success' ? theme.success : theme.dimText}>
          {statusMessage}
        </Text>
      ) : undefined}
    >
      <CommandTabs
        tabs={TABS.map((value) => ({ id: value, label: capitalize(value) }))}
        selected={tab}
      />

      <Box marginTop={1} flexDirection="column">
        {form.kind === 'list' && renderList(
          tab,
          visibleItems,
          selectedIndex - listWindow.start,
          cfg,
          pingResults,
          listWindow.hasAbove,
          listWindow.hasBelow,
        )}
        {form.kind === 'endpoint-edit' && renderEndpointForm(form)}
        {form.kind === 'model-edit' && renderModelForm(form, cfg)}
        {form.kind === 'routing-edit' && renderRoutingForm(form, routingOptions(cfg))}
        {form.kind === 'confirm-delete' && (
          <Text color={theme.warning}>
            Delete {form.what.slice(0, -1)} "{form.targetId}"? [y/N]
          </Text>
        )}
        {form.kind === 'busy' && <Text color={theme.dimText}>{form.message}</Text>}
      </Box>

    </CommandPane>
  )
}

// ---------- helpers ----------

interface ListItem {
  id: string
  primary: string
  secondary?: string
}

function collectListItems(cfg: Config, tab: Tab): ListItem[] {
  if (tab === 'endpoints') {
    return Object.entries(cfg.endpoints ?? {}).map(([name, ep]) => ({
      id: name,
      primary: `${name}  [${ep.provider}]`,
      secondary: ep.baseUrl ?? '(no baseUrl)',
    }))
  }
  if (tab === 'models') {
    return Object.entries(cfg.models).map(([name, m]) => ({
      id: name,
      primary: `${name}  ${m.endpoint ? `-> endpoint:${m.endpoint}` : `[${m.provider}]`}`,
      secondary: m.model,
    }))
  }
  // routing
  return ROUTING_ROLES.map((role) => ({
    id: role,
    primary: role.padEnd(22),
    secondary: String(currentRoutingValue(cfg, role)),
  }))
}

/**
 * What a role resolves to today. Absent means `'inherit'` for every role —
 * `DEFAULT_ROUTING` no longer promotes plan or demotes compact, because with
 * tiers gone there is nothing to promote to.
 */
function currentRoutingValue(cfg: Config, role: RoutingRoleKey): string {
  const r = cfg.routing ?? {}
  if (role === 'main') return r.main ?? 'inherit'
  if (role === 'plan') return r.plan ?? 'inherit'
  if (role === 'compact') return r.compact ?? 'inherit'
  const subType = role.slice('subagent.'.length)
  return r.subagent?.[subType] ?? 'inherit'
}

function applyRoutingChange(routing: Routing, role: RoutingRoleKey, value: string): Routing {
  const next: Routing = {
    main: routing.main,
    plan: routing.plan,
    compact: routing.compact,
    subagent: { ...routing.subagent },
  }
  if (role === 'main' || role === 'plan' || role === 'compact') {
    next[role] = value
    return next
  }
  const subType = role.slice('subagent.'.length)
  next.subagent = { ...next.subagent, [subType]: value }
  return next
}

function renderList(
  tab: Tab,
  items: ListItem[],
  selectedIndex: number,
  cfg: Config,
  pingResults: Record<string, EndpointPingResult>,
  hasAbove: boolean,
  hasBelow: boolean,
) {
  if (items.length === 0) {
    return <Text color={theme.dimText}>No {tab} configured. Press [n] to create one.</Text>
  }
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const selected = i === selectedIndex
        const ping = tab === 'endpoints' ? pingResults[item.id] : undefined
        const pingTag = ping ? `  ${ping.ok ? 'OK' : 'ERR'} ${ping.message}` : ''
        return (
          <CommandListItem
            key={item.id}
            focused={selected}
            selected={false}
            showMoreAbove={i === 0 && hasAbove}
            showMoreBelow={i === items.length - 1 && hasBelow}
            description={item.secondary ? maskMaybe(tab, item.secondary, item.id, cfg) : undefined}
          >
            {item.primary}
            {pingTag ? <Text color={ping?.ok ? theme.success : theme.error}>{pingTag}</Text> : null}
          </CommandListItem>
        )
      })}
    </Box>
  )
}

function maskMaybe(tab: Tab, secondary: string, _id: string, _cfg: Config): string {
  // Endpoints' secondary is baseUrl, never apiKey, so no mask needed today.
  // Kept as a hook for future fields that may include key material.
  if (tab !== 'endpoints') return secondary
  return secondary
}

function renderEndpointForm(form: Extract<FormState, { kind: 'endpoint-edit' }>) {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>{form.original ? `Edit endpoint "${form.original}"` : 'New endpoint'}</Text>
      <FieldRow label="Name"     value={form.nameInput} active={form.field === 'nameInput'}     cursor={form.field === 'nameInput'     ? form.cursor : undefined} />
      <ChoiceFieldRow
        label="Provider"
        value={isSupportedProviderName(form.provider) ? form.provider : `${form.provider} (unsupported)`}
        active={form.field === 'provider'}
      />
      <FieldRow label="Base URL" value={form.baseUrl}   active={form.field === 'baseUrl'}  cursor={form.field === 'baseUrl'  ? form.cursor : undefined} />
      <FieldRow
        label="API Key"
        value={form.apiKey}
        active={form.field === 'apiKey'}
        cursor={form.field === 'apiKey' ? form.cursor : undefined}
        maskedValue={form.field === 'apiKey' ? form.apiKey : maskKey(form.apiKey)}
      />
    </Box>
  )
}

function renderModelForm(form: Extract<FormState, { kind: 'model-edit' }>, cfg: Config) {
  const endpoint = form.endpointName ? cfg.endpoints?.[form.endpointName] : undefined
  const endpointDisplay = !form.endpointName
    ? '(missing endpoint)'
    : endpoint
      ? form.endpointName
      : `${form.endpointName} (missing)`
  const inheritedProviderDisplay = endpoint && !isSupportedProviderName(endpoint.provider)
    ? `${endpoint.provider} (unsupported)`
    : endpoint?.provider ?? '(unavailable)'
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>{form.original ? `Edit model "${form.original}"` : 'New model'}</Text>
      <FieldRow label="Name"        value={form.nameInput}    active={form.field === 'nameInput'}         cursor={form.field === 'nameInput'         ? form.cursor : undefined} />
      <FieldRow label="Model ID"    value={form.modelId}      active={form.field === 'modelId'}      cursor={form.field === 'modelId'      ? form.cursor : undefined} />
      <ChoiceFieldRow label="Endpoint" value={endpointDisplay} active={form.field === 'endpointName'} />
      <ChoiceFieldRow label="Context" value={form.contextWindow} active={form.field === 'contextWindow'} />
      <FieldRow label="Provider" value={inheritedProviderDisplay} active={false} hint="inherited from endpoint" />
    </Box>
  )
}

function renderRoutingForm(form: Extract<FormState, { kind: 'routing-edit' }>, options: readonly string[]) {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>Routing: {form.role}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Text key={opt} color={i === form.valueIndex ? theme.brand : theme.assistantText}>
            {i === form.valueIndex ? '>' : '  '}
            {opt}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

interface FieldRowProps {
  label: string
  value: string
  active: boolean
  cursor?: number
  /** When set, the value is shown with this masked replacement, but the
   *  caret position is still computed against the unmasked length so editing
   *  feels predictable. */
  maskedValue?: string
  hint?: string
}

function FieldRow({ label, value, active, cursor, maskedValue, hint }: FieldRowProps) {
  const display = maskedValue ?? value
  const safeCursor = cursor === undefined ? display.length : Math.min(Math.max(0, cursor), display.length)
  const before = display.slice(0, safeCursor)
  const at = display.slice(safeCursor, safeCursor + 1)
  const after = display.slice(safeCursor + 1)
  const fieldLabel = `${active ? '> ' : '  '}${label.padEnd(10)}: `
  return (
    <Box>
      <Text color={active ? theme.brand : theme.dimText}>{fieldLabel}</Text>
      {active ? (
        <Text color={theme.assistantText}>
          {before}
          <Text inverse>{at.length > 0 ? at : ' '}</Text>
          {after}
        </Text>
      ) : (
        <Text color={theme.dimText}>{display.length === 0 ? '(empty)' : display}</Text>
      )}
      {hint && <Text color={theme.dimText}>  {hint}</Text>}
    </Box>
  )
}

interface ChoiceFieldRowProps {
  label: string
  value: string
  active: boolean
}

function ChoiceFieldRow({ label, value, active }: ChoiceFieldRowProps) {
  const fieldLabel = `${active ? '> ' : '  '}${label.padEnd(10)}: `
  return (
    <Box>
      <Text color={active ? theme.brand : theme.dimText}>{fieldLabel}</Text>
      <Text color={active ? theme.assistantText : theme.dimText}>
        {active ? `‹ ${value} ›` : value}
      </Text>
    </Box>
  )
}

function modelChoiceLabel(value: string, cfg: Config): string {
  if (!value) return '(missing model)'
  return cfg.models[value] ? value : `${value} (missing)`
}

function footerHints(tab: Tab, form: FormState): CommandHint[] {
  if (form.kind === 'endpoint-edit' || form.kind === 'model-edit') {
    const action = isChoiceField(form) ? 'change' : 'cursor'
    return [
      { key: '↑/↓', action: 'change field' },
      { key: '←/→', action },
      { key: 'Tab', action: 'next field' },
      { key: 'Enter', action: 'save' },
      { key: 'Esc', action: 'cancel' },
    ]
  }
  if (form.kind === 'routing-edit') {
    return [{ key: '↑/↓', action: 'choose' }, { key: 'Enter', action: 'save' }, { key: 'Esc', action: 'cancel' }]
  }
  if (form.kind === 'confirm-delete') {
    return [{ key: 'Y', action: 'confirm' }, { key: 'N/Esc', action: 'cancel' }]
  }
  const base: CommandHint[] = [
    { key: '↑/↓', action: 'navigate' },
    { key: '←/→', action: 'switch section' },
  ]
  if (tab === 'routing') return [...base, { key: 'Enter', action: 'edit' }, { key: 'Esc', action: 'close' }]
  return [...base, { key: 'Esc', action: 'close' }, { key: 'N', action: 'new' }, { key: 'E', action: 'edit' }, { key: 'D', action: 'delete' }]
}

function isChoiceField(form: Extract<FormState, { kind: 'endpoint-edit' | 'model-edit' }>): boolean {
  if (form.kind === 'endpoint-edit') return form.field === 'provider'
  return form.field === 'endpointName' || form.field === 'contextWindow'
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Subset of Ink's Key type that the panel cares about. Declared explicitly
 * so we can pass it through pure helpers without importing Ink's types
 * (Ink doesn't re-export the full Key shape, and TS infers the same
 * compatible shape from useInput's callback parameter).
 */
export interface InkKey {
  return?: boolean
  escape?: boolean
  tab?: boolean
  shift?: boolean
  backspace?: boolean
  delete?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  home?: boolean
  end?: boolean
  ctrl?: boolean
  meta?: boolean
}

/**
 * Apply a key event to a (value, cursor) pair, returning the next pair.
 * Pure function -- no React state.
 *
 * Recognised keys:
 *   - printable input         : insert at cursor
 *   - backspace               : delete char before cursor
 *   - delete                  : delete char at cursor
 *   - leftArrow / rightArrow  : move cursor by one
 *   - home / Ctrl+A           : jump to start
 *   - end  / Ctrl+E           : jump to end
 *
 * Non-text keys (Tab/Enter/Esc/arrows up&down/etc) are forwarded by
 * returning the input unchanged. Callers should intercept those before
 * delegating here.
 */
export function applyTextInputKey(
  value: string,
  cursor: number,
  input: string,
  key: InkKey,
): { value: string; cursor: number } {
  const c = clampCursor(cursor, value.length)

  if (key.leftArrow) {
    return { value, cursor: Math.max(0, c - 1) }
  }
  if (key.rightArrow) {
    return { value, cursor: Math.min(value.length, c + 1) }
  }
  if (key.home || (key.ctrl && input === 'a')) {
    return { value, cursor: 0 }
  }
  if (key.end || (key.ctrl && input === 'e')) {
    return { value, cursor: value.length }
  }
  if (key.backspace) {
    if (c === 0) return { value, cursor: 0 }
    return { value: value.slice(0, c - 1) + value.slice(c), cursor: c - 1 }
  }
  if (key.delete) {
    if (c >= value.length) return { value, cursor: c }
    return { value: value.slice(0, c) + value.slice(c + 1), cursor: c }
  }
  // Treat all printable input. Multi-char chunks (paste) are inserted
  // wholesale at the cursor.
  if (input && !isControl(input) && !key.ctrl && !key.meta) {
    return {
      value: value.slice(0, c) + input + value.slice(c),
      cursor: c + input.length,
    }
  }
  return { value, cursor: c }
}

/** Cycle a choice value while preserving an unknown legacy value until the
 * user explicitly moves away from it. Empty option lists are a no-op. */
export function cycleChoiceValue(
  value: string,
  options: readonly string[],
  direction: -1 | 1,
): string {
  if (options.length === 0) return value
  const choices = options.includes(value) ? [...options] : [value, ...options]
  const current = choices.indexOf(value)
  return choices[(current + direction + choices.length) % choices.length] ?? value
}

/** Move within a vertical list without wrapping at either boundary. */
export function moveBoundedIndex(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0
  const safeCurrent = Math.min(Math.max(0, current), length - 1)
  return Math.min(Math.max(0, safeCurrent + direction), length - 1)
}

/** Move within a cyclic horizontal or Tab sequence. */
export function moveCyclicIndex(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0
  const safeCurrent = Math.min(Math.max(0, current), length - 1)
  return (safeCurrent + direction + length) % length
}

function choiceDirection(key: InkKey): -1 | 0 | 1 {
  if (key.leftArrow) return -1
  if (key.rightArrow) return 1
  return 0
}

function isSaveKey(input: string, key: InkKey): boolean {
  return key.ctrl === true && (input.toLowerCase() === 's' || input === '\x13')
}

function clampCursor(cursor: number, max: number): number {
  if (!Number.isFinite(cursor)) return max
  if (cursor < 0) return 0
  if (cursor > max) return max
  return cursor
}

/**
 * Apply a key event to the currently active field of a text-edit form.
 * Looks up the form's `field` to find which string property to mutate, and
 * uses `applyTextInputKey` to compute the next (value, cursor) pair.
 */
function applyKeyToForm<
  F extends FormState & { field: string; cursor: number },
>(form: F, input: string, key: InkKey): F {
  const fieldName = form.field as keyof F
  const current = (form[fieldName] as unknown as string) ?? ''
  const { value, cursor } = applyTextInputKey(current, form.cursor, input, key)
  if (value === current && cursor === form.cursor) return form
  return { ...(form as object), [fieldName]: value, cursor } as F
}

function isControl(input: string): boolean {
  if (input.length === 0) return true
  // Treat anything below printable ASCII as control. This filters out arrow
  // keys, function keys, etc., which Ink delivers via key flags but also
  // sometimes leaks into `input` as escape sequences on certain terminals.
  // For multi-char input (paste), check the first character -- actual paste
  // payloads start with a printable character.
  return input.charCodeAt(0) < 0x20
}
