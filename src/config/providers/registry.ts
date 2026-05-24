import type { ModelProvider } from '../../harness/types.js'
import type { ModelConfig } from '../service.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { OpenAIProvider } from './openaiProvider.js'

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
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'openai':
      return new OpenAIProvider(config)
    default:
      return undefined
  }
}
