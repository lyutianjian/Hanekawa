import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getConfigPath } from '../utils/paths.js'

export interface ModelConfig {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface AgentConfig {
  system?: string
  maxTokens?: number
  contextBudget?: number
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
    contextBudget: 100_000,
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
    this.config = await readJsonFile(this.configPath, DEFAULT_CONFIG)
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
