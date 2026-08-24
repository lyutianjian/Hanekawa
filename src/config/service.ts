import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { existsSync } from 'node:fs'
import { getConfigPath, getGlobalConfigPath } from '../utils/paths.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { ModelPricing } from '../harness/types.js'
import type { MyAgentSettings } from './settings.js'
import type { EffortLevel } from './effort.js'
import {
  mergeRouting,
  pickRoutedModel,
  type Endpoint,
  type Routing,
  type RoutingRole,
} from './routing.js'

/**
 * The three tier names that `routing` / `defaultModel` used to hold.
 *
 * Kept only so a config written before tiers were removed can be recognized and
 * warned about; nothing resolves through them any more.
 */
const LEGACY_TIER_NAMES: readonly string[] = ['fast', 'balanced', 'powerful']

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

export interface ModelConfig {
  provider?: string
  model: string
  contextWindow?: number
  endpoint?: string
  apiKey?: string
  baseUrl?: string
  promptCacheRetention?: 'in_memory' | '24h'
  pricing?: ModelPricing
  maxOutputTokens?: number
  thinking?: ThinkingConfig
  maxEffort?: EffortLevel
}

export interface AgentConfig {
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  sessionDir?: string
  agentTimeoutMs?: number
}

export interface Config {
  endpoints?: Record<string, Endpoint>
  models: Record<string, ModelConfig>
  routing?: Routing
  defaultModel?: string
  fallbackModel?: string
  compactModel?: string
  agent: AgentConfig
}

const DEFAULT_CONFIG: Config = {
  models: {},
  agent: {
    contextManagement: {
      contextWindow: 200_000,
      summaryOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
      autoCompactThresholdRatio: 0.93,
    },
  },
}

export interface ConfigServiceOptions {
  /** Absolute path to the shared config layer; `null` disables it (tests). */
  globalConfigPath?: string | null
}

export class ConfigService {
  private config: Config
  private configPath: string
  private globalConfigPath: string | null
  /** Human-readable notes about tier-era config found by the last `load()`. */
  private legacyModelFindings: string[] = []

  constructor(cwd: string, options?: ConfigServiceOptions) {
    this.configPath = getConfigPath(cwd)
    const global = options?.globalConfigPath === undefined ? getGlobalConfigPath() : options.globalConfigPath
    // Running directly inside the home directory would otherwise load the same
    // file as both layers.
    this.globalConfigPath = global === this.configPath ? null : global
    this.config = structuredClone(DEFAULT_CONFIG)
  }

  async load(settings?: MyAgentSettings): Promise<void> {
    const globalLoaded = this.globalConfigPath
      ? await readJsonFile<Partial<Config>>(this.globalConfigPath, {})
      : {}
    const loaded = await readJsonFile<Partial<Config>>(this.configPath, {})
    const settingsConfig = configFromSettings(settings)
    this.config = deepMergeConfig(
      deepMergeConfig(deepMergeConfig(DEFAULT_CONFIG, settingsConfig), globalLoaded),
      loaded,
    )
    // The raw layers, not the merged result: `Config` no longer has a `profiles`
    // field, so a tier-era file's profiles survive only as untyped extras on the
    // objects we just read.
    this.legacyModelFindings = this.migrateLegacyTiers([settings, globalLoaded, loaded])
  }

  /**
   * What the last `load()` found left over from the tier era, already repaired.
   *
   * Reported rather than thrown, following `fallbackModel` / `compactModel`:
   * a stale config should start with a warning and a sane model, not refuse to
   * launch. `bootstrap()` turns these into `RuntimeDiagnostic`s.
   */
  getLegacyModelFindings(): readonly string[] {
    return this.legacyModelFindings
  }

  /**
   * Recognize tier-era config, warn about it, and leave something workable.
   *
   * A tier name is only legacy when it does *not* name a real model. A user with
   * a model literally keyed `fast` and `routing.main: "fast"` has written a
   * perfectly valid new-style config, and rewriting it to `'inherit'` would
   * break a working setup to fix an imaginary one. (`resolveModelInput` has
   * always had to answer this same ambiguity in the model's favour.)
   *
   * Two repairs, both chosen so the agent still starts with a real model:
   *  - a `routing` value naming a tier becomes `'inherit'`, since the role it
   *    described no longer exists and inheriting the main model is the closest
   *    honest reading;
   *  - a `defaultModel` naming a tier becomes the first model key that actually
   *    resolves, because leaving it would make `getDefaultModel()` return
   *    undefined and nothing would answer "which model am I".
   */
  private migrateLegacyTiers(rawLayers: readonly (object | undefined)[]): string[] {
    const findings: string[] = []
    const isStaleTier = (value: string): boolean =>
      LEGACY_TIER_NAMES.includes(value.trim()) && !this.resolveModel(value.trim())

    for (const layer of rawLayers) {
      if (!layer) continue
      const record = layer as Record<string, unknown>
      if (record.profiles !== undefined) {
        findings.push('`profiles` is no longer supported; routing now names model keys directly.')
      }
      if (record.activeProfile !== undefined) {
        findings.push('`activeProfile` is no longer supported; routing now names model keys directly.')
      }
    }

    const routing = this.config.routing
    if (routing) {
      for (const role of ['main', 'plan', 'compact'] as const) {
        const value = routing[role]
        if (value !== undefined && isStaleTier(value)) {
          findings.push(`routing.${role} was the tier "${value}"; treating it as "inherit".`)
          routing[role] = 'inherit'
        }
      }
      for (const [type, value] of Object.entries(routing.subagent ?? {})) {
        if (value !== undefined && isStaleTier(value)) {
          findings.push(`routing.subagent.${type} was the tier "${value}"; treating it as "inherit".`)
          routing.subagent![type] = 'inherit'
        }
      }
    }

    const defaultModel = this.config.defaultModel
    if (defaultModel !== undefined && isStaleTier(defaultModel)) {
      const replacement = Object.keys(this.config.models).find((key) => this.resolveModel(key))
      if (replacement) {
        findings.push(`defaultModel was the tier "${defaultModel}"; using model "${replacement}" instead.`)
        this.config.defaultModel = replacement
      } else {
        findings.push(`defaultModel was the tier "${defaultModel}" and no configured model resolves; it has been dropped.`)
        delete this.config.defaultModel
      }
    }

    // Deduplicate: `profiles` in two layers is one story, not two.
    return [...new Set(findings)]
  }

  /**
   * Project config wins when it exists, so a repo that opted into its own
   * config keeps owning it. Otherwise writes go to the shared layer rather than
   * scattering API keys into every directory the agent is launched from.
   */
  getSaveTarget(): string {
    if (!this.globalConfigPath) return this.configPath
    return existsSync(this.configPath) ? this.configPath : this.globalConfigPath
  }

  async save(): Promise<void> {
    await writeJsonFile(this.getSaveTarget(), this.config)
  }

  get(): Config {
    return this.config
  }

  getModel(name: string): ModelConfig | undefined {
    return this.resolveModel(name)
  }

  getDefaultModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.defaultModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  getFallbackModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.fallbackModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  getCompactModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.compactModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  setDefaultModel(name: string): void {
    if (this.resolveModelReference(name)) {
      this.config.defaultModel = name
    }
  }

  addModel(name: string, model: ModelConfig): void {
    this.config.models[name] = model
  }

  resolveModel(name: string): ModelConfig | undefined {
    const model = this.config.models[name]
    if (!model) return undefined

    if (!model.endpoint) {
      return model.provider ? { ...model } : undefined
    }

    const endpoint = this.config.endpoints?.[model.endpoint]
    if (!endpoint) return undefined
    const resolved: ModelConfig = {
      provider: endpoint.provider,
      ...(endpoint.baseUrl !== undefined ? { baseUrl: endpoint.baseUrl } : {}),
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...model,
    }
    return resolved.provider ? resolved : undefined
  }

  /**
   * Which model key a role should run on.
   *
   * Three steps, and there is no fourth: look the role up in `routing`; if it
   * named a model key that resolves, use it; otherwise — `'inherit'`, absent, or
   * a name that no longer resolves — fall back to the current model, then to
   * `defaultModel`. An unresolvable routing entry degrading to the parent model
   * is deliberate: it is what makes deleting a model a recoverable mistake.
   */
  resolveModelKeyFor(role: RoutingRole, options: { currentModelKey?: string } = {}): string | undefined {
    const fallback = this.resolveFallbackModelKey(options.currentModelKey)
    const routed = pickRoutedModel(this.getRouting(), role)
    if (routed === undefined || routed === 'inherit') return fallback
    return this.resolveModel(routed) ? routed : fallback
  }

  resolveModelInput(input: string): string | undefined {
    return this.resolveModelReference(input)
  }

  /**
   * A configured name to a usable model key. `'inherit'` is not a
   * misconfiguration — it resolves to nothing on purpose.
   */
  resolveModelReference(reference: string | undefined): string | undefined {
    const trimmed = reference?.trim()
    if (!trimmed) return undefined
    if (trimmed.toLowerCase() === 'inherit') return undefined
    return this.resolveModel(trimmed) ? trimmed : undefined
  }

  private resolveFallbackModelKey(currentModelKey?: string): string | undefined {
    if (currentModelKey && this.resolveModel(currentModelKey)) return currentModelKey
    return this.resolveModelReference(this.config.defaultModel)
  }

  getEndpoint(name: string): Endpoint | undefined {
    return this.config.endpoints?.[name]
  }

  setEndpoint(name: string, endpoint: Endpoint): void {
    this.config.endpoints = { ...this.config.endpoints, [name]: endpoint }
  }

  removeEndpoint(name: string): void {
    for (const [modelName, model] of Object.entries(this.config.models)) {
      if (model.endpoint === name) {
        throw new Error(`Cannot remove endpoint "${name}": referenced by model "${modelName}".`)
      }
    }
    if (!this.config.endpoints?.[name]) return
    const { [name]: _removed, ...rest } = this.config.endpoints
    this.config.endpoints = Object.keys(rest).length > 0 ? rest : undefined
  }

  setModelConfig(name: string, model: ModelConfig): void {
    this.config.models = { ...this.config.models, [name]: model }
  }

  removeModel(name: string): void {
    if (this.config.defaultModel === name || this.resolveModelReference(this.config.defaultModel) === name) {
      throw new Error(`Cannot remove model "${name}": it is the defaultModel.`)
    }
    if (this.config.fallbackModel === name) {
      throw new Error(`Cannot remove model "${name}": it is the fallbackModel.`)
    }
    if (this.config.compactModel === name) {
      throw new Error(`Cannot remove model "${name}": it is the compactModel.`)
    }
    // Routing holds model keys now, so it is the fourth place a model can be
    // spoken for — the successor to the profile check this replaced. Without it
    // a removal silently leaves a role pointing at nothing.
    for (const [role, value] of routingReferences(this.config.routing)) {
      if (value === name) {
        throw new Error(`Cannot remove model "${name}": referenced by routing.${role}.`)
      }
    }
    delete this.config.models[name]
  }

  renameModel(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return
    const model = this.config.models[oldKey]
    if (!model) throw new Error(`Model "${oldKey}" not found.`)
    if (this.config.models[newKey]) throw new Error(`Model "${newKey}" already exists.`)

    this.setModelConfig(newKey, model)
    delete this.config.models[oldKey]

    if (this.config.defaultModel === oldKey) this.config.defaultModel = newKey
    if (this.config.fallbackModel === oldKey) this.config.fallbackModel = newKey
    if (this.config.compactModel === oldKey) this.config.compactModel = newKey

    const routing = this.config.routing
    if (routing) {
      for (const role of ['main', 'plan', 'compact'] as const) {
        if (routing[role] === oldKey) routing[role] = newKey
      }
      for (const [type, value] of Object.entries(routing.subagent ?? {})) {
        if (value === oldKey) routing.subagent![type] = newKey
      }
    }
  }

  getRouting(): Routing {
    return mergeRouting(this.config.routing)
  }

  setRouting(routing: Routing): void {
    this.config.routing = mergeRouting(routing)
  }

  /**
   * Patches `agent.contextManagement`, one field or several.
   *
   * Written here rather than into a settings layer because `load()` stacks
   * `config.json` *on top of* settings (`configFromSettings`), so a value
   * written to `settings.local.json` would be silently overridden by any
   * `config.json` that names the same field.
   *
   * Throws on a value that cannot mean anything, the way `removeModel` does:
   * these six numbers feed the token budget, and a zero context window or a
   * ratio above 1 does not degrade — it makes every turn either compact
   * immediately or never.
   */
  setContextManagement(patch: Partial<ContextManagementConfig>): void {
    const sanitized = sanitizeContextManagement(patch)
    if (!sanitized) return
    for (const [field, value] of Object.entries(sanitized) as Array<[keyof ContextManagementConfig, number]>) {
      const isRatio = field === 'microCompactThresholdRatio' || field === 'autoCompactThresholdRatio'
      if (isRatio) {
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new Error(`agent.contextManagement.${field} must be a ratio in (0, 1].`)
        }
      } else if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`agent.contextManagement.${field} must be a positive integer.`)
      }
    }
    this.config.agent = {
      ...this.config.agent,
      contextManagement: { ...this.config.agent.contextManagement, ...sanitized },
    }
  }
}

/**
 * Every `role -> value` pair in a routing map, subagents included, as
 * `['plan', 'sonnet']` / `['subagent.explore', 'haiku']`. One walk shared by the
 * removal check and anything else that has to ask "who points at this model".
 */
function routingReferences(routing: Routing | undefined): Array<[string, string]> {
  if (!routing) return []
  const pairs: Array<[string, string]> = []
  for (const role of ['main', 'plan', 'compact'] as const) {
    const value = routing[role]
    if (value !== undefined) pairs.push([role, value])
  }
  for (const [type, value] of Object.entries(routing.subagent ?? {})) {
    if (value !== undefined) pairs.push([`subagent.${type}`, value])
  }
  return pairs
}

function configFromSettings(settings?: MyAgentSettings): Partial<Config> {
  if (!settings) return {}

  return {
    ...(settings.models ? { models: settings.models } : {}),
    ...(settings.endpoints ? { endpoints: settings.endpoints } : {}),
    ...(settings.routing ? { routing: settings.routing } : {}),
    ...(settings.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
    ...(settings.fallbackModel !== undefined ? { fallbackModel: settings.fallbackModel } : {}),
    ...(settings.compactModel !== undefined ? { compactModel: settings.compactModel } : {}),
    ...(settings.agent ? { agent: settings.agent } : {}),
  }
}

function deepMergeConfig(base: Config, overrides: Partial<Config>): Config {
  const contextManagement = sanitizeContextManagement(overrides.agent?.contextManagement)
  return {
    endpoints: { ...base.endpoints, ...overrides.endpoints },
    models: { ...base.models, ...overrides.models },
    routing: mergeRouting(base.routing, overrides.routing),
    defaultModel: overrides.defaultModel ?? base.defaultModel,
    fallbackModel: overrides.fallbackModel ?? base.fallbackModel,
    compactModel: overrides.compactModel ?? base.compactModel,
    agent: {
      ...base.agent,
      ...overrides.agent,
      contextManagement: {
        ...base.agent.contextManagement,
        ...contextManagement,
      },
    },
  }
}

function sanitizeContextManagement(
  config?: Partial<ContextManagementConfig>,
): Partial<ContextManagementConfig> | undefined {
  if (!config) return undefined
  return {
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    ...(config.summaryOutputTokens !== undefined ? { summaryOutputTokens: config.summaryOutputTokens } : {}),
    ...(config.autoCompactBufferTokens !== undefined ? { autoCompactBufferTokens: config.autoCompactBufferTokens } : {}),
    ...(config.manualCompactBufferTokens !== undefined ? { manualCompactBufferTokens: config.manualCompactBufferTokens } : {}),
    ...(config.microCompactThresholdRatio !== undefined ? { microCompactThresholdRatio: config.microCompactThresholdRatio } : {}),
    ...(config.autoCompactThresholdRatio !== undefined ? { autoCompactThresholdRatio: config.autoCompactThresholdRatio } : {}),
  }
}
