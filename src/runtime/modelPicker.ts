import { resolveImageCapability } from '../config/providers/registry.js'
import type { ConfigService } from '../config/service.js'

/**
 * The slice of `ConfigService` this builder actually reads.
 *
 * Declared structurally so a test can pass a plain object with **no
 * `as unknown as`** — the cast is precisely what would hide it if this function
 * started reading a member the fake does not have. `ConfigService` satisfies it,
 * so callers are unaffected.
 */
export interface ModelPickerConfig {
  get(): { defaultModel?: string }
  getModel(name: string): { provider?: string; model: string; supportsImageInput?: boolean } | undefined
  resolveModelReference(reference: string | undefined): string | undefined
}

// The real service must keep satisfying the shape above.
const _configIsCompatible: (config: ConfigService) => ModelPickerConfig = (config) => config
void _configIsCompatible

/**
 * The model picker's options, resolved against config.
 *
 * This has to run wherever `ConfigService` lives rather than in the viewer:
 * `resolveModel` folds the endpoint's `apiKey` and `baseUrl` into what
 * `getModel` returns, so a renderer can never be handed the service itself.
 * The result is plain scalars and crosses the wire as part of
 * `WireModelsResult`.
 *
 * One row per configured model key. A key that does not resolve — a dangling
 * `endpoint` reference, say — is still listed, disabled, with the reason on it:
 * a model the user configured and cannot select needs to explain itself, and
 * silently dropping the row makes it look like the config was never read.
 */
export interface ModelPickerOption {
  /** The model key this row selects; also its stable row id. */
  key: string
  label: string
  modelKey?: string
  providerName?: string
  modelId?: string
  /**
   * Effective image-input capability — `resolveImageCapability` of the model,
   * not the raw config switch, so "the adapter cannot carry images" and "the
   * user left it off" read the same here. Absent means no. The marker a picker
   * draws comes from this; no frontend keeps its own model whitelist.
   */
  supportsImageInput?: boolean
  disabledReason?: string
  isCurrent: boolean
  isDefault: boolean
}

export function buildModelPickerOptions(
  config: ModelPickerConfig,
  currentModelKey: string | undefined,
  knownModelKeys: string[],
): ModelPickerOption[] {
  const defaultModelKey = config.resolveModelReference(config.get().defaultModel)
  return knownModelKeys.map((key) => {
    const model = config.getModel(key)
    if (!model) {
      return {
        key,
        label: key,
        disabledReason: `Configured model "${key}" could not be loaded.`,
        isCurrent: false,
        isDefault: false,
      }
    }

    return {
      key,
      label: key,
      modelKey: key,
      providerName: model.provider ?? 'unknown',
      modelId: model.model,
      ...(resolveImageCapability(model) ? { supportsImageInput: true } : {}),
      isCurrent: key === currentModelKey,
      isDefault: key === defaultModelKey,
    }
  })
}
