import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getConfigPath } from '../utils/paths.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { ModelPricing } from '../harness/types.js'

export interface ModelConfig {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  promptCacheRetention?: 'in_memory' | '24h'
  pricing?: ModelPricing
  maxOutputTokens?: number
}

export interface AgentConfig {
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  sessionDir?: string
}

export interface Config {
  models: Record<string, ModelConfig>
  defaultModel?: string
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

  async load(): Promise<void> {
    const loaded = await readJsonFile<Partial<Config>>(this.configPath, {})
    this.config = deepMergeConfig(DEFAULT_CONFIG, loaded)
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

  setDefaultModel(name: string): void {
    if (this.config.models[name]) {
      this.config.defaultModel = name
    }
  }

  addModel(name: string, model: ModelConfig): void {
    this.config.models[name] = model
  }
}

function deepMergeConfig(base: Config, overrides: Partial<Config>): Config {
  return {
    models: { ...base.models, ...overrides.models },
    defaultModel: overrides.defaultModel ?? base.defaultModel,
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
