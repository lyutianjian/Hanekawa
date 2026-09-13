import { clampEffort } from '../config/effort.js'
import type { ConfigService } from '../config/service.js'
import type { ActiveModelRuntime, AgentRunOverrides } from '../harness/loop.js'
import type { CommandSubmitQueryOptions } from '../commands/types.js'
import type { RuntimeSlot } from './runtimeSlot.js'

/**
 * Turning a skill command's declared overrides into what `AgentLoop.run` takes.
 *
 * Skill commands are prompt macros with per-invocation model, effort and tool
 * overrides. The model has to become a live `ActiveModelRuntime`, which is why
 * this cannot live on the wire side of the protocol — `WireRunOverrides` carries
 * a model *key* and the host runs this to resolve it.
 *
 * Effort is clamped against whichever model will actually serve the run: the
 * override's, when there is one, otherwise the live slot's. A numeric clamp
 * result is dropped rather than passed on, because `AgentRunOverrides.effort` is
 * the level enum.
 */
export interface RunOverridesDeps {
  config: ConfigService
  runtimeSlot: RuntimeSlot
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
}

export function buildRunOverrides(
  deps: RunOverridesDeps,
  options?: CommandSubmitQueryOptions,
): AgentRunOverrides | undefined {
  if (!options) return undefined
  let modelOverride: ActiveModelRuntime | undefined
  let effortOverride = options.effort

  if (options.model) {
    const modelKey = deps.config.resolveModelInput(options.model)
    if (!modelKey) {
      throw new Error(`Unknown model for skill command: ${options.model}`)
    }
    const modelConfig = deps.config.getModel(modelKey)
    if (!modelConfig) {
      throw new Error(`Unknown model for skill command: ${options.model}`)
    }
    modelOverride = deps.createActiveModelRuntime(modelKey)
    if (effortOverride) {
      const clamped = clampEffort(effortOverride, modelConfig.supportedEfforts)
      effortOverride = typeof clamped === 'string' ? clamped : undefined
    }
  } else if (effortOverride) {
    const clamped = clampEffort(effortOverride, deps.runtimeSlot.requireCurrent().modelConfig.supportedEfforts)
    effortOverride = typeof clamped === 'string' ? clamped : undefined
  }

  return {
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(effortOverride ? { effort: effortOverride } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.skillName ? { skillName: options.skillName } : {}),
    ...(options.skillArgs !== undefined ? { skillArgs: options.skillArgs } : {}),
    ...(options.displayInput !== undefined ? { displayInput: options.displayInput } : {}),
  }
}
