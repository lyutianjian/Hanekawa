import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getConfigPath } from '../utils/paths.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { ModelPricing } from '../harness/types.js'
import type { MyAgentSettings } from './settings.js'
import {
  mergeRouting,
  pickTier,
  parseTierInput,
  resolveTier,
  type Endpoint,
  type Profile,
  type Routing,
  type RoutingRole,
} from './routing.js'

export interface ThinkingConfig {
  enabled: boolean
  budgetTokens?: number
}

export interface ModelConfig {
  provider?: string
  model: string
  endpoint?: string
  apiKey?: string
  baseUrl?: string
  promptCacheRetention?: 'in_memory' | '24h'
  pricing?: ModelPricing
  maxOutputTokens?: number
  thinking?: ThinkingConfig
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
  profiles?: Record<string, Profile>
  activeProfile?: string
  routing?: Routing
  defaultModel?: string
  fallbackModel?: string
  compactModel?: string
  agent: AgentConfig
}

const DEFAULT_CONFIG: Config = {
  models: {
    anthropic: {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    },
  },
  defaultModel: 'anthropic',
  agent: {
    contextManagement: {
      contextWindow: 200_000,
      summaryOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.65,
      snipThresholdRatio: 0.8,
      autoCompactThresholdRatio: 0.9,
      snipHeadTurns: 3,
      snipTailTurns: 12,
      snipMaxTurns: 24,
    },
  },
}

export class ConfigService {
  private config: Config
  private configPath: string

  constructor(cwd: string) {
    this.configPath = getConfigPath(cwd)
    this.config = structuredClone(DEFAULT_CONFIG)
  }

  async load(settings?: MyAgentSettings): Promise<void> {
    const loaded = await readJsonFile<Partial<Config>>(this.configPath, {})
    const settingsConfig = configFromSettings(settings)
    this.config = deepMergeConfig(deepMergeConfig(DEFAULT_CONFIG, settingsConfig), loaded)
  }

  async save(): Promise<void> {
    await writeJsonFile(this.configPath, this.config)
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

  resolveModelKeyFor(role: RoutingRole, options: { currentModelKey?: string } = {}): string | undefined {
    const fallback = this.resolveFallbackModelKey(options.currentModelKey)
    const tier = pickTier(this.getRouting(), role)
    if (tier === undefined || tier === 'inherit') return fallback

    const active = this.getActiveProfile()
    const routed = resolveTier(active?.profile, tier)
    return routed && this.resolveModel(routed) ? routed : fallback
  }

  resolveModelInput(input: string, options: { currentModelKey?: string } = {}): string | undefined {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    if (trimmed.toLowerCase() === 'inherit') return undefined

    return this.resolveModelReference(trimmed)
      ?? (parseTierInput(trimmed) ? this.resolveFallbackModelKey(options.currentModelKey) : undefined)
  }

  resolveModelReference(reference: string | undefined): string | undefined {
    const trimmed = reference?.trim()
    if (!trimmed) return undefined
    if (trimmed.toLowerCase() === 'inherit') return undefined

    if (this.resolveModel(trimmed)) return trimmed

    const tier = parseTierInput(trimmed)
    if (!tier) return undefined

    const active = this.getActiveProfile()
    const routed = resolveTier(active?.profile, tier)
    return routed && this.resolveModel(routed)
      ? routed
      : undefined
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
    if (this.config.defaultModel === name) {
      throw new Error(`Cannot remove model "${name}": it is the defaultModel.`)
    }
    if (this.config.fallbackModel === name) {
      throw new Error(`Cannot remove model "${name}": it is the fallbackModel.`)
    }
    if (this.config.compactModel === name) {
      throw new Error(`Cannot remove model "${name}": it is the compactModel.`)
    }
    for (const [profileName, profile] of Object.entries(this.config.profiles ?? {})) {
      for (const tier of ['fast', 'balanced', 'powerful'] as const) {
        if (profile[tier] === name) {
          throw new Error(`Cannot remove model "${name}": referenced by profile "${profileName}.${tier}".`)
        }
      }
    }
    delete this.config.models[name]
  }

  setProfile(name: string, profile: Profile): void {
    this.config.profiles = { ...this.config.profiles, [name]: profile }
  }

  removeProfile(name: string): void {
    if (!this.config.profiles?.[name]) return
    const { [name]: _removed, ...rest } = this.config.profiles
    this.config.profiles = Object.keys(rest).length > 0 ? rest : undefined
    if (this.config.activeProfile === name) {
      delete this.config.activeProfile
    }
  }

  setActiveProfile(name: string): void {
    if (!this.config.profiles?.[name]) {
      throw new Error(`Unknown profile: ${name}`)
    }
    this.config.activeProfile = name
  }

  getActiveProfile(): { name: string; profile: Profile } | undefined {
    if (this.config.activeProfile) {
      const profile = this.config.profiles?.[this.config.activeProfile]
      return profile ? { name: this.config.activeProfile, profile } : undefined
    }
    const entries = Object.entries(this.config.profiles ?? {})
    if (entries.length !== 1) return undefined
    const [name, profile] = entries[0]!
    return { name, profile }
  }

  getRouting(): Routing {
    return mergeRouting(this.config.routing)
  }

  setRouting(routing: Routing): void {
    this.config.routing = mergeRouting(routing)
  }
}

function configFromSettings(settings?: MyAgentSettings): Partial<Config> {
  if (!settings) return {}

  return {
    ...(settings.models ? { models: settings.models } : {}),
    ...(settings.endpoints ? { endpoints: settings.endpoints } : {}),
    ...(settings.profiles ? { profiles: settings.profiles } : {}),
    ...(settings.activeProfile !== undefined ? { activeProfile: settings.activeProfile } : {}),
    ...(settings.routing ? { routing: settings.routing } : {}),
    ...(settings.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
    ...(settings.fallbackModel !== undefined ? { fallbackModel: settings.fallbackModel } : {}),
    ...(settings.compactModel !== undefined ? { compactModel: settings.compactModel } : {}),
    ...(settings.agent ? { agent: settings.agent } : {}),
  }
}

function deepMergeConfig(base: Config, overrides: Partial<Config>): Config {
  return {
    endpoints: { ...base.endpoints, ...overrides.endpoints },
    models: { ...base.models, ...overrides.models },
    profiles: { ...base.profiles, ...overrides.profiles },
    activeProfile: overrides.activeProfile ?? base.activeProfile,
    routing: mergeRouting(base.routing, overrides.routing),
    defaultModel: overrides.defaultModel ?? base.defaultModel,
    fallbackModel: overrides.fallbackModel ?? base.fallbackModel,
    compactModel: overrides.compactModel ?? base.compactModel,
    agent: {
      ...base.agent,
      ...overrides.agent,
      contextManagement: {
        ...base.agent.contextManagement,
        ...overrides.agent?.contextManagement,
      },
    },
  }
}
