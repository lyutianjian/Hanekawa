import type { ModelProvider } from '../../harness/types.js'
import type { ModelConfig } from '../service.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { OpenAIProvider } from './openaiProvider.js'

export const SUPPORTED_PROVIDER_NAMES = ['anthropic', 'openai'] as const

export type SupportedProviderName = typeof SUPPORTED_PROVIDER_NAMES[number]

export function isSupportedProviderName(value: string): value is SupportedProviderName {
  return SUPPORTED_PROVIDER_NAMES.some((provider) => provider === value)
}

const PROVIDER_FACTORIES: Record<SupportedProviderName, (config: ModelConfig) => ModelProvider> = {
  anthropic: (config) => new AnthropicProvider(config),
  openai: (config) => new OpenAIProvider(config),
}

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map()

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider)
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name)
  }

  has(name: string): boolean {
    return this.providers.has(name)
  }

  list(): string[] {
    return Array.from(this.providers.keys())
  }
}

export function createProvider(config: ModelConfig): ModelProvider | undefined {
  if (!config.provider || !isSupportedProviderName(config.provider)) return undefined
  return PROVIDER_FACTORIES[config.provider](config)
}
