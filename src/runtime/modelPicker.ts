import type { ConfigService } from '../config/service.js'
import { resolveTier, type Tier } from '../config/routing.js'

/**
 * The model picker's options, resolved against config.
 *
 * This has to run wherever `ConfigService` lives rather than in the viewer:
 * `resolveModel` folds the endpoint's `apiKey` and `baseUrl` into what
 * `getModel` returns, so a renderer can never be handed the service itself.
 * The result is plain scalars and crosses the wire as part of
 * `WireModelsResult`.
 */
export interface ModelPickerOption {
  tier: Tier
  label: string
  modelKey?: string
  providerName?: string
  modelId?: string
  disabledReason?: string
  isCurrent: boolean
  isDefault: boolean
}

const MODEL_PICKER_TIERS: Array<{ tier: Tier; label: string }> = [
  { tier: 'fast', label: 'Fast' },
  { tier: 'balanced', label: 'Balanced' },
  { tier: 'powerful', label: 'Powerful' },
]

export function buildModelPickerOptions(
  config: ConfigService,
  currentModelKey: string,
  knownModelKeys: string[],
): ModelPickerOption[] {
  const defaultModelKey = config.resolveModelReference(config.get().defaultModel)
  return MODEL_PICKER_TIERS.map(({ tier, label }) => {
    const modelKey = resolveTierModelKey(config, tier, currentModelKey)
    if (!modelKey || !knownModelKeys.includes(modelKey)) {
      return {
        tier,
        label,
        disabledReason: 'No configured model resolves for this tier.',
        isCurrent: false,
        isDefault: false,
      }
    }

    const model = config.getModel(modelKey)
    if (!model) {
      return {
        tier,
        label,
        disabledReason: `Configured model "${modelKey}" could not be loaded.`,
        isCurrent: false,
        isDefault: false,
      }
    }

    return {
      tier,
      label,
      modelKey,
      providerName: model.provider ?? 'unknown',
      modelId: model.model,
      isCurrent: modelKey === currentModelKey,
      isDefault: modelKey === defaultModelKey,
    }
  })
}

function resolveTierModelKey(config: ConfigService, tier: Tier, currentModelKey: string): string | undefined {
  const routed = resolveTier(config.getActiveProfile()?.profile, tier)
  if (routed && config.getModel(routed)) return routed
  if (currentModelKey && config.getModel(currentModelKey)) return currentModelKey
  return config.resolveModelReference(config.get().defaultModel)
}
