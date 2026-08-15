import { parseTierInput } from '../config/routing.js'
import type { ConfigService } from '../config/service.js'
import type { SessionRecord } from '../harness/types.js'
import type { SetModelResult } from '../commands/types.js'
import type { SessionMeta } from '../sessions/service.js'
import type { AgentSession } from './types.js'
import type { RuntimeSlot } from './runtimeSlot.js'

/**
 * Switching the model the live runtime is bound to, as `/model <name>` means it.
 *
 * This is a superset of the `set-model` host command, and the difference is
 * deliberate: `set-model` points the current runtime somewhere else, while
 * `/model` is the user naming a preference, so it also writes the tier back to
 * config. Do not fold the persistence into `set-model` — a fallback activation
 * or a picker preview would start rewriting the user's default.
 *
 * Errors come back as `SetModelResult` rather than thrown: every caller renders
 * the message, and the list of available models is part of that message.
 */
export interface ModelSwitchDeps {
  config: ConfigService
  runtimeSlot: RuntimeSlot
  /** Model keys as currently configured; the caller owns refreshing this. */
  availableModelKeys: readonly string[]
  createRuntime: (modelKey: string, session: SessionMeta, records: readonly SessionRecord[]) => AgentSession
  getSession: () => SessionMeta
  /** The live record list, folded into the new runtime's task state. */
  getRecords: () => readonly SessionRecord[]
}

/** The three tier names are always offerable, whether or not they are keys. */
function availableModels(deps: ModelSwitchDeps): string[] {
  return [...deps.availableModelKeys, 'fast', 'balanced', 'powerful']
}

/**
 * Replaces the runtime with one bound to `modelKey`. Does not touch config.
 *
 * `clearCachedSections` before the swap: the cached Environment section embeds
 * the model name, so a stale prefix would survive into the next request.
 */
export function activateModelKey(deps: ModelSwitchDeps, modelKey: string): SetModelResult {
  if (!deps.availableModelKeys.includes(modelKey)) {
    return {
      ok: false,
      message: `Unknown model: ${modelKey}`,
      availableModels: availableModels(deps),
    }
  }

  try {
    const nextRuntime = deps.createRuntime(modelKey, deps.getSession(), deps.getRecords())
    deps.runtimeSlot.current.loop.clearCachedSections()
    deps.runtimeSlot.replace(nextRuntime)
    // Re-apply current effort clamped to the new model's maxEffort.
    deps.runtimeSlot.reapplyEffort()
    return {
      ok: true,
      model: {
        key: nextRuntime.modelKey,
        model: nextRuntime.modelConfig.model,
        providerName: nextRuntime.providerName,
      },
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      availableModels: availableModels(deps),
    }
  }
}

/**
 * `activateModelKey` plus the tier write-back, resolving a model *or* tier name.
 *
 * The config save is fire-and-forget on purpose: the switch has already taken
 * effect in the live slot, and failing to persist a preference must not read as
 * a failed switch.
 */
export function switchModel(deps: ModelSwitchDeps, input: string): SetModelResult {
  const modelKey = deps.config.resolveModelInput(input, {
    currentModelKey: deps.runtimeSlot.current.modelKey,
  })
  if (!modelKey) {
    return {
      ok: false,
      message: input.trim().toLowerCase() === 'inherit'
        ? '/model inherit is not supported. inherit is only valid in routing/subagent settings.'
        : `Unknown model or tier: ${input}`,
      availableModels: availableModels(deps),
    }
  }
  const result = activateModelKey(deps, modelKey)
  if (result.ok) {
    const tier = parseTierInput(input) ?? deps.config.findTierForModel(modelKey)
    if (tier) {
      deps.config.setDefaultModel(tier)
      void deps.config.save().catch(() => {})
    }
  }
  return result
}
