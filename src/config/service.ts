import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getConfigPath } from '../utils/paths.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { ModelPricing } from '../harness/types.js'
import type { MyAgentSettings } from './settings.js'

export interface ThinkingConfig {
  enabled: boolean
  budgetTokens?: number
}

export interface ModelConfig {
  provider: string
  model: string
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
}

export interface Config {
  models: Record<string, ModelConfig>
  defaultModel?: string
  fallbackModel?: string
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
    },
  },
}

export class ConfigService {
  private config: Config
  private configPath: string

  constructor(cwd: string) {
    this.configPath = getConfigPath(cwd)
    this.config = { ...DEFAULT_CONFIG }
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
    return this.config.models[name]
  }

  getDefaultModel(): ModelConfig | undefined {
    if (!this.config.defaultModel) return undefined
    return this.config.models[this.config.defaultModel]
  }

  getFallbackModel(): ModelConfig | undefined {
    if (!this.config.fallbackModel) return undefined
    return this.config.models[this.config.fallbackModel]
  }

  setDefaultModel(name: string): void {
    if (this.config.models[name]) {
      this.config.defaultModel = name
    }
  }

  addModel(name: string, model: ModelConfig): void {
    this.config.models[name] = model
  }
}

function configFromSettings(settings?: MyAgentSettings): Partial<Config> {
  if (!settings) return {}

  return {
    ...(settings.models ? { models: settings.models } : {}),
    ...(settings.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
    ...(settings.fallbackModel !== undefined ? { fallbackModel: settings.fallbackModel } : {}),
    ...(settings.agent ? { agent: settings.agent } : {}),
  }
}

function deepMergeConfig(base: Config, overrides: Partial<Config>): Config {
  return {
    models: { ...base.models, ...overrides.models },
    defaultModel: overrides.defaultModel ?? base.defaultModel,
    fallbackModel: overrides.fallbackModel ?? base.fallbackModel,
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
