import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { theme } from '../theme.js'
import type {
  Config,
  ModelConfig,
  ConfigService,
} from '../../config/service.js'
import type {
  Endpoint,
  Profile,
  Routing,
  Tier,
  TierOrInherit,
} from '../../config/routing.js'
import { pingEndpoint, type EndpointPingResult } from '../../config/endpointPing.js'

type Tab = 'endpoints' | 'models' | 'profiles' | 'routing'
const TABS: readonly Tab[] = ['endpoints', 'models', 'profiles', 'routing']
const TIER_OPTIONS: readonly TierOrInherit[] = ['inherit', 'fast', 'balanced', 'powerful']

type FormState =
  | { kind: 'list' }
  | { kind: 'endpoint-edit'; nameInput: string; provider: string; baseUrl: string; apiKey: string; field: 'nameInput' | 'provider' | 'baseUrl' | 'apiKey'; cursor: number; original: string | null }
  | { kind: 'model-edit'; nameInput: string; modelId: string; endpointName: string; provider: string; field: 'nameInput' | 'modelId' | 'endpointName' | 'provider'; cursor: number; original: string | null }
  | { kind: 'profile-edit'; nameInput: string; fast: string; balanced: string; powerful: string; field: 'nameInput' | 'fast' | 'balanced' | 'powerful'; cursor: number; original: string | null }
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
  | 'subagent.verification'

const ROUTING_ROLES: readonly RoutingRoleKey[] = [
  'main',
  'plan',
  'compact',
  'subagent.general',
  'subagent.fork',
  'subagent.explore',
  'subagent.plan',
  'subagent.verification',
]

export interface ProviderPanelProps {
  config: ConfigService
  /** Notify the parent when config has been mutated and saved. The parent
   *  should refresh any cached views (e.g. /model output). */
  onChange: () => void
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

  // Items are recomputed on every render. config.get() returns the same Config
  // object reference even after mutations, so we cannot rely on referential
  // equality for memoization -- instead we accept the O(n) cost (n is small)
  // and let React re-render on form / tab / status changes that always
  // accompany config mutations.
  const cfg = config.get()
  const items = collectListItems(cfg, tab)

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
      onChange()
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
    if (form.kind === 'endpoint-edit' || form.kind === 'model-edit' || form.kind === 'profile-edit') {
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
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1))
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
    const next = TABS[(idx + delta + TABS.length) % TABS.length] ?? 'endpoints'
    setTab(next)
    setSelectedIndex(0)
    setStatusMessage(null)
  }

  function handleEnter() {
    if (tab === 'profiles') {
      const item = items[selectedIndex]
      if (!item) return
      void persist(
        () => config.setActiveProfile(item.id),
        `Active profile set to "${item.id}"`,
      )
      return
    }
    if (tab === 'routing') {
      handleEdit()
      return
    }
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
      setForm({
        kind: 'model-edit',
        nameInput: '',
        modelId: '',
        endpointName: '',
        provider: '',
        field: 'nameInput',
        cursor: 0,
        original: null,
      })
      return
    }
    if (tab === 'profiles') {
      setForm({
        kind: 'profile-edit',
        nameInput: '',
        fast: '',
        balanced: '',
        powerful: '',
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
        provider: m.provider ?? '',
        field: 'modelId',
        cursor: m.model.length,
        original: item.id,
      })
      return
    }
    if (tab === 'profiles') {
      const p = cfg.profiles?.[item.id]
      if (!p) return
      setForm({
        kind: 'profile-edit',
        nameInput: item.id,
        fast: p.fast ?? '',
        balanced: p.balanced ?? '',
        powerful: p.powerful ?? '',
        field: 'fast',
        cursor: (p.fast ?? '').length,
        original: item.id,
      })
      return
    }
    if (tab === 'routing') {
      const role = ROUTING_ROLES[selectedIndex]
      if (!role) return
      const current = currentRoutingValue(cfg, role)
      const valueIndex = Math.max(0, TIER_OPTIONS.indexOf(current))
      setForm({ kind: 'routing-edit', role, valueIndex })
      return
    }
  }

  function handleDelete() {
    const item = items[selectedIndex]
    if (!item) return
    if (tab === 'endpoints' || tab === 'models' || tab === 'profiles') {
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
      else if (what === 'profiles') config.removeProfile(targetId)
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
    } else if (form.kind === 'profile-edit') {
      handleProfileFormInput(input, key)
    }
  }

  function handleEndpointFormInput(input: string, key: InkKey) {
    if (form.kind !== 'endpoint-edit') return
    if (key.tab) {
      const fields: Array<typeof form.field> = ['nameInput', 'provider', 'baseUrl', 'apiKey']
      const next = fields[(fields.indexOf(form.field) + 1) % fields.length]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.return) {
      const name = form.nameInput.trim()
      if (!name) return flashStatus('Name is required', 'error')
      const provider = form.provider.trim() || 'anthropic'
      const endpoint: Endpoint = {
        provider,
        ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }
      void persist(() => {
        if (form.original && form.original !== name) {
          config.removeEndpoint(form.original)
        }
        config.setEndpoint(name, endpoint)
      }, `Saved endpoint "${name}"`)
      return
    }
    setForm(applyKeyToForm(form, input, key))
  }

  function handleModelFormInput(input: string, key: InkKey) {
    if (form.kind !== 'model-edit') return
    if (key.tab) {
      const fields: Array<typeof form.field> = ['nameInput', 'modelId', 'endpointName', 'provider']
      const next = fields[(fields.indexOf(form.field) + 1) % fields.length]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.return) {
      const name = form.nameInput.trim()
      if (!name) return flashStatus('Name is required', 'error')
      if (!form.modelId.trim()) return flashStatus('Model id is required', 'error')
      if (!form.endpointName.trim() && !form.provider.trim()) {
        return flashStatus('Either endpoint or provider is required', 'error')
      }
      if (form.endpointName.trim() && !cfg.endpoints?.[form.endpointName.trim()]) {
        return flashStatus(`Unknown endpoint "${form.endpointName}"`, 'error')
      }
      const model: ModelConfig = {
        model: form.modelId.trim(),
        ...(form.endpointName.trim() ? { endpoint: form.endpointName.trim() } : {}),
        ...(form.provider.trim() && !form.endpointName.trim() ? { provider: form.provider.trim() } : {}),
      }
      void persist(() => {
        if (form.original && form.original !== name) {
          config.removeModel(form.original)
        }
        config.setModelConfig(name, model)
      }, `Saved model "${name}"`)
      return
    }
    setForm(applyKeyToForm(form, input, key))
  }

  function handleProfileFormInput(input: string, key: InkKey) {
    if (form.kind !== 'profile-edit') return
    if (key.tab) {
      const fields: Array<typeof form.field> = ['nameInput', 'fast', 'balanced', 'powerful']
      const next = fields[(fields.indexOf(form.field) + 1) % fields.length]!
      setForm({ ...form, field: next, cursor: form[next].length })
      return
    }
    if (key.return) {
      const name = form.nameInput.trim()
      if (!name) return flashStatus('Name is required', 'error')
      const profile: Profile = {}
      if (form.fast.trim()) profile.fast = form.fast.trim()
      if (form.balanced.trim()) profile.balanced = form.balanced.trim()
      if (form.powerful.trim()) profile.powerful = form.powerful.trim()
      const knownModels = new Set(Object.keys(cfg.models))
      for (const v of Object.values(profile)) {
        if (v && !knownModels.has(v)) {
          return flashStatus(`Unknown model "${v}"`, 'error')
        }
      }
      void persist(() => {
        if (form.original && form.original !== name) {
          config.removeProfile(form.original)
        }
        config.setProfile(name, profile)
      }, `Saved profile "${name}"`)
      return
    }
    setForm(applyKeyToForm(form, input, key))
  }

  function handleRoutingFormInput(input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean }) {
    if (form.kind !== 'routing-edit') return
    if (key.escape) {
      setForm({ kind: 'list' })
      return
    }
    if (key.upArrow || key.leftArrow) {
      setForm({ ...form, valueIndex: (form.valueIndex - 1 + TIER_OPTIONS.length) % TIER_OPTIONS.length })
      return
    }
    if (key.downArrow || key.rightArrow) {
      setForm({ ...form, valueIndex: (form.valueIndex + 1) % TIER_OPTIONS.length })
      return
    }
    if (key.return) {
      const value = TIER_OPTIONS[form.valueIndex]!
      const role = form.role
      const next = applyRoutingChange(config.getRouting(), role, value)
      void persist(() => config.setRouting(next), `Routing ${role} -> ${value}`)
    }
  }

  // ---------- render ----------

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} padding={1} marginY={1}>
      <Box>
        {TABS.map((t, i) => (
          <Box key={t} marginRight={2}>
            <Text bold color={t === tab ? theme.brand : theme.dimText}>
              {t === tab ? `[${capitalize(t)}]` : ` ${capitalize(t)} `}
            </Text>
            {i < TABS.length - 1 && <Text color={theme.dimText}> </Text>}
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {form.kind === 'list' && renderList(tab, items, selectedIndex, cfg, pingResults)}
        {form.kind === 'endpoint-edit' && renderEndpointForm(form)}
        {form.kind === 'model-edit' && renderModelForm(form, cfg)}
        {form.kind === 'profile-edit' && renderProfileForm(form, cfg)}
        {form.kind === 'routing-edit' && renderRoutingForm(form)}
        {form.kind === 'confirm-delete' && (
          <Text color={theme.warning}>
            Delete {form.what.slice(0, -1)} "{form.targetId}"? [y/N]
          </Text>
        )}
        {form.kind === 'busy' && <Text color={theme.dimText}>{form.message}</Text>}
      </Box>

      {statusMessage && (
        <Box marginTop={1}>
          <Text color={statusKind === 'error' ? theme.error : statusKind === 'success' ? theme.success : theme.dimText}>
            {statusMessage}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dimText}>{footerHint(tab, form)}</Text>
      </Box>
    </Box>
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
  if (tab === 'profiles') {
    return Object.entries(cfg.profiles ?? {}).map(([name, p]) => {
      const tiers = (['fast', 'balanced', 'powerful'] as const)
        .map((t) => `${t}=${p[t] ?? '-'}`)
        .join('  ')
      return {
        id: name,
        primary: name + (cfg.activeProfile === name ? '  (active)' : ''),
        secondary: tiers,
      }
    })
  }
  // routing
  return ROUTING_ROLES.map((role) => ({
    id: role,
    primary: role.padEnd(22),
    secondary: String(currentRoutingValue(cfg, role)),
  }))
}

function currentRoutingValue(cfg: Config, role: RoutingRoleKey): TierOrInherit {
  const r = cfg.routing ?? {}
  if (role === 'main') return r.main ?? 'balanced'
  if (role === 'plan') return r.plan ?? 'powerful'
  if (role === 'compact') return r.compact ?? 'fast'
  const subType = role.slice('subagent.'.length)
  const sub = r.subagent?.[subType]
  if (sub !== undefined) return sub
  if (subType === 'general' || subType === 'fork') return 'inherit'
  if (subType === 'explore') return 'balanced'
  if (subType === 'plan') return 'powerful'
  if (subType === 'verification') return 'balanced'
  return 'inherit'
}

function applyRoutingChange(routing: Routing, role: RoutingRoleKey, value: TierOrInherit): Routing {
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
          <Box key={item.id} flexDirection="column" marginBottom={tab === 'profiles' ? 1 : 0}>
            <Text color={selected ? theme.brand : theme.assistantText}>
              {selected ? '> ' : '  '}
              {item.primary}
              {pingTag && (
                <Text color={ping?.ok ? theme.success : theme.error}> {pingTag}</Text>
              )}
            </Text>
            {item.secondary && (
              <Text color={theme.dimText}>    {maskMaybe(tab, item.secondary, item.id, cfg)}</Text>
            )}
          </Box>
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
      <FieldRow label="Provider" value={form.provider}  active={form.field === 'provider'} cursor={form.field === 'provider' ? form.cursor : undefined} hint="anthropic | openai" />
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
  const known = Object.keys(cfg.endpoints ?? {}).join(', ') || '(none)'
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>{form.original ? `Edit model "${form.original}"` : 'New model'}</Text>
      <FieldRow label="Name"        value={form.nameInput}    active={form.field === 'nameInput'}         cursor={form.field === 'nameInput'         ? form.cursor : undefined} />
      <FieldRow label="Model ID"    value={form.modelId}      active={form.field === 'modelId'}      cursor={form.field === 'modelId'      ? form.cursor : undefined} />
      <FieldRow label="Endpoint"    value={form.endpointName} active={form.field === 'endpointName'} cursor={form.field === 'endpointName' ? form.cursor : undefined} hint={`one of: ${known}`} />
      <FieldRow label="Provider"    value={form.provider}     active={form.field === 'provider'}     cursor={form.field === 'provider'     ? form.cursor : undefined} hint="(only used when endpoint is empty)" />
    </Box>
  )
}

function renderProfileForm(form: Extract<FormState, { kind: 'profile-edit' }>, cfg: Config) {
  const known = Object.keys(cfg.models).join(', ')
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>{form.original ? `Edit profile "${form.original}"` : 'New profile'}</Text>
      <FieldRow label="Name"     value={form.nameInput} active={form.field === 'nameInput'}     cursor={form.field === 'nameInput'     ? form.cursor : undefined} />
      <FieldRow label="Fast"     value={form.fast}      active={form.field === 'fast'}     cursor={form.field === 'fast'     ? form.cursor : undefined} hint={`models: ${known}`} />
      <FieldRow label="Balanced" value={form.balanced}  active={form.field === 'balanced'} cursor={form.field === 'balanced' ? form.cursor : undefined} hint={`models: ${known}`} />
      <FieldRow label="Powerful" value={form.powerful}  active={form.field === 'powerful'} cursor={form.field === 'powerful' ? form.cursor : undefined} hint={`models: ${known}`} />
    </Box>
  )
}

function renderRoutingForm(form: Extract<FormState, { kind: 'routing-edit' }>) {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.brand}>Routing: {form.role}</Text>
      <Box marginTop={1} flexDirection="column">
        {TIER_OPTIONS.map((opt, i) => (
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
  return (
    <Box>
      <Text color={active ? theme.brand : theme.dimText}>{label.padEnd(10)}: </Text>
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

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return key.slice(0, 4) + '...' + key.slice(-4)
}

function footerHint(tab: Tab, form: FormState): string {
  if (form.kind === 'endpoint-edit' || form.kind === 'model-edit' || form.kind === 'profile-edit') {
    return '[Tab] next field  [Left/Right/Home/End] move  [Enter] save  [Esc] cancel'
  }
  if (form.kind === 'routing-edit') {
    return '[Up/Down] choose  [Enter] save  [Esc] cancel'
  }
  if (form.kind === 'confirm-delete') {
    return '[y] confirm  [n / Esc] cancel'
  }
  if (tab === 'endpoints') return '[Up/Down] move  [n] new  [e] edit  [d] delete  [t] test  [Tab] next tab  [q/Esc] close'
  if (tab === 'profiles')  return '[Up/Down] move  [Enter] activate  [n] new  [e] edit  [d] delete  [Tab] next tab  [q/Esc] close'
  if (tab === 'models')    return '[Up/Down] move  [n] new  [e] edit  [d] delete  [Tab] next tab  [q/Esc] close'
  return '[Up/Down] move  [Enter] edit  [Tab] next tab  [q/Esc] close'
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
