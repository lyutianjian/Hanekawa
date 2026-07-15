import type { ConfigService } from '../config/service.js'

export type ProviderConfigChangeScope = 'endpoints' | 'models' | 'profiles' | 'routing'

/** Resolve the model that should back the live TUI after /provider changes. */
export function resolveRuntimeModelKeyAfterConfigChange(
  config: ConfigService,
  currentModelKey: string,
  scope: ProviderConfigChangeScope,
): string | undefined {
  if (scope === 'profiles' || scope === 'routing') {
    return config.resolveModelKeyFor({ kind: 'main' }, { currentModelKey })
  }

  if (config.getModel(currentModelKey)) return currentModelKey
  return config.resolveModelKeyFor({ kind: 'main' })
}
