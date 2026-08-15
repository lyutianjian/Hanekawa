import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRunOverrides, type RunOverridesDeps } from '../src/runtime/runOverrides.js'
import type { ConfigService } from '../src/config/service.js'
import type { ActiveModelRuntime } from '../src/harness/loop.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'

/**
 * Skill commands carry per-invocation model/effort/tool overrides, and the model
 * has to become a live `ActiveModelRuntime` -- which is why this runs host-side
 * and `WireRunOverrides` carries only a model key.
 *
 * The clamping is the part worth pinning: effort is bounded by whichever model
 * will actually serve the run, and a numeric clamp result is dropped rather than
 * passed on, because `AgentRunOverrides.effort` is the level enum.
 */

const MODELS: Record<string, { maxEffort?: string } | undefined> = {
  current: { maxEffort: 'medium' },
  capped: { maxEffort: 'low' },
  uncapped: {},
}

function createDeps(): { deps: RunOverridesDeps; activated: string[] } {
  const activated: string[] = []

  const runtimeSlot = {
    current: { modelKey: 'current', modelConfig: MODELS.current },
  } as unknown as RuntimeSlot

  const config = {
    resolveModelInput: (input: string) => (input in MODELS ? input : undefined),
    getModel: (key: string) => MODELS[key],
  } as unknown as ConfigService

  return {
    activated,
    deps: {
      config,
      runtimeSlot,
      createActiveModelRuntime: (modelKey: string) => {
        activated.push(modelKey)
        return { model: modelKey } as unknown as ActiveModelRuntime
      },
    },
  }
}

test('no options means no overrides at all', () => {
  const { deps } = createDeps()
  assert.equal(buildRunOverrides(deps), undefined)
})

test('an empty options object still yields an object, not undefined', () => {
  const { deps } = createDeps()
  assert.deepEqual(buildRunOverrides(deps, {}), {})
})

test('a model override is resolved into a live runtime', () => {
  const { deps, activated } = createDeps()

  const overrides = buildRunOverrides(deps, { model: 'uncapped' })

  assert.deepEqual(activated, ['uncapped'])
  assert.deepEqual(overrides?.model, { model: 'uncapped' })
})

test('effort is clamped against the override model, not the live one', () => {
  const { deps } = createDeps()

  // The live model allows `medium`; the override model caps at `low`.
  assert.equal(buildRunOverrides(deps, { model: 'capped', effort: 'high' })?.effort, 'low')
  assert.equal(buildRunOverrides(deps, { model: 'uncapped', effort: 'high' })?.effort, 'high')
})

test('with no model override the live slot supplies the cap', () => {
  const { deps } = createDeps()
  assert.equal(buildRunOverrides(deps, { effort: 'max' })?.effort, 'medium')
  assert.equal(buildRunOverrides(deps, { effort: 'low' })?.effort, 'low')
})

test('a numeric effort is dropped rather than passed on as a level', () => {
  const { deps } = createDeps()

  // `clampEffort` returns a numeric effort untouched (it is a raw token budget,
  // not a rank), but `AgentRunOverrides.effort` is the level enum -- so the
  // `typeof clamped === 'string'` guard has to drop it. Unreachable through
  // `CommandSubmitQueryOptions`, whose `effort` is typed as a level; reachable
  // from anything that went through `parseEffortInput`, which returns numbers.
  const budget = 4096 as unknown as 'high'
  assert.equal('effort' in (buildRunOverrides(deps, { effort: budget }) ?? {}), false)
  assert.equal('effort' in (buildRunOverrides(deps, { model: 'capped', effort: budget }) ?? {}), false)
})

test('an unresolvable model is a throw, since a skill named it explicitly', () => {
  const { deps } = createDeps()

  assert.throws(
    () => buildRunOverrides(deps, { model: 'ghost' }),
    /Unknown model or tier for skill command: ghost/,
  )
})

test('a resolvable key with no config entry is reported separately', () => {
  const { deps } = createDeps()
  const config = deps.config as unknown as { getModel: (key: string) => unknown }
  config.getModel = () => undefined

  assert.throws(
    () => buildRunOverrides(deps, { model: 'uncapped' }),
    /Unknown model for skill command: uncapped/,
  )
})

test('the remaining fields pass through, and absent ones stay absent', () => {
  const { deps } = createDeps()

  const overrides = buildRunOverrides(deps, {
    allowedTools: ['Read'],
    skillName: 'review',
    skillArgs: '',
    displayInput: '/review',
  })

  assert.deepEqual(overrides, {
    allowedTools: ['Read'],
    skillName: 'review',
    // An empty string is a real value here and must not be dropped as falsy.
    skillArgs: '',
    displayInput: '/review',
  })
})

test('hooks ride along in-process, which is why the wire type omits them', () => {
  const { deps } = createDeps()
  const hooks = { PreToolUse: [] }

  const overrides = buildRunOverrides(deps, { hooks: hooks as never })
  assert.equal(overrides?.hooks, hooks)
})
