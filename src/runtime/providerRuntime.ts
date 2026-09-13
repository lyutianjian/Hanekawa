import type { ConfigService } from '../config/service.js'
import type { SessionRecord } from '../harness/types.js'
import type { SessionMeta } from '../sessions/service.js'
import type { CreateRuntime } from './createRuntime.js'
import { MISSING_MODEL_ISSUE, RuntimeStartupError, type RuntimeConfigurationIssue } from './errors.js'
import type { RuntimeSlot } from './runtimeSlot.js'
import type { AgentSession } from './types.js'

export type ProviderConfigChangeScope = 'endpoints' | 'models' | 'routing'

/** Resolve the model that should back the live runtime after /provider changes. */
export function resolveRuntimeModelKeyAfterConfigChange(
  config: ConfigService,
  currentModelKey: string | undefined,
  scope: ProviderConfigChangeScope,
): string | undefined {
  if (scope === 'routing') {
    return config.resolveModelKeyFor({ kind: 'main' }, { currentModelKey })
  }

  if (currentModelKey && config.getModel(currentModelKey)) return currentModelKey
  return config.resolveModelKeyFor({ kind: 'main' })
}

/** Startup and settings edits share the same recoverable model-creation path. */
export function refreshRuntimeSlot(deps: {
  config: ConfigService
  runtimeSlot: RuntimeSlot
  createRuntime: CreateRuntime
  modelKey: string | undefined
  session: SessionMeta
  records?: readonly SessionRecord[]
}): void {
  let next: AgentSession | undefined
  let issue: RuntimeConfigurationIssue = MISSING_MODEL_ISSUE
  if (deps.modelKey) {
    try {
      next = deps.createRuntime(deps.modelKey, deps.session, deps.records)
    } catch (error) {
      if (!(error instanceof RuntimeStartupError) || error.code === 'invalid_settings') throw error
      issue = { code: error.code, message: error.message }
    }
  } else {
    const configured = deps.config.get().defaultModel?.trim()
    if (configured && configured.toLowerCase() !== 'inherit') {
      issue = { code: 'no_default_model', message: `Default model could not be resolved: ${configured}.` }
    }
  }
  deps.runtimeSlot.current?.loop.clearCachedSections()
  deps.runtimeSlot.replace(next, issue)
  deps.runtimeSlot.reapplyEffort()
}
