import test from 'node:test'
import assert from 'node:assert/strict'
import { activateModelKey, switchModel, type ModelSwitchDeps } from '../src/runtime/modelSwitch.js'
import type { ConfigService } from '../src/config/service.js'
import type { SessionRecord } from '../src/harness/types.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { AgentSession } from '../src/runtime/types.js'

/**
 * `/model` is a superset of the `set-model` host command: it also writes the
 * tier back to config. That difference had no coverage while this lived inline
 * in `App.tsx`, and it is the whole reason the two are separate functions -- a
 * fallback activation or a picker preview must not rewrite the user's default.
 */

interface Calls {
  created: Array<{ modelKey: string; sessionId: string; recordCount: number }>
  clearedCachedSections: number
  replaced: string[]
  reappliedEffort: number
  defaultModels: string[]
  saves: number
}

function createDeps(overrides: {
  availableModelKeys?: string[]
  resolveModelInput?: (input: string) => string | undefined
  findTierForModel?: (modelKey: string) => string | undefined
  createRuntimeThrows?: string
} = {}): { deps: ModelSwitchDeps; calls: Calls } {
  const calls: Calls = {
    created: [],
    clearedCachedSections: 0,
    replaced: [],
    reappliedEffort: 0,
    defaultModels: [],
    saves: 0,
  }

  const session = { id: 'session-1' } as SessionMeta
  const records: SessionRecord[] = [
    { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
    { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  ]

  const runtimeSlot = {
    current: {
      modelKey: 'current',
      modelConfig: { model: 'current-model', maxEffort: 'high' },
      providerName: 'anthropic',
      loop: { clearCachedSections: () => { calls.clearedCachedSections += 1 } },
    },
    replace: (next: AgentSession) => { calls.replaced.push(next.modelKey) },
    reapplyEffort: () => { calls.reappliedEffort += 1; return 'high' },
  } as unknown as RuntimeSlot

  const config = {
    resolveModelInput: overrides.resolveModelInput
      ? (input: string) => overrides.resolveModelInput!(input)
      : (input: string) => (input === 'nope' ? undefined : input),
    findTierForModel: overrides.findTierForModel ?? (() => undefined),
    setDefaultModel: (name: string) => { calls.defaultModels.push(name) },
    save: async () => { calls.saves += 1 },
  } as unknown as ConfigService

  return {
    calls,
    deps: {
      config,
      runtimeSlot,
      availableModelKeys: overrides.availableModelKeys ?? ['current', 'other', 'fastModel'],
      createRuntime: (modelKey, target, recordList) => {
        if (overrides.createRuntimeThrows) throw new Error(overrides.createRuntimeThrows)
        calls.created.push({ modelKey, sessionId: target.id, recordCount: recordList.length })
        return {
          modelKey,
          modelConfig: { model: `${modelKey}-model` },
          providerName: 'anthropic',
        } as AgentSession
      },
      getSession: () => session,
      getRecords: () => records,
    },
  }
}

test('activateModelKey replaces the runtime and reports the new model', () => {
  const { deps, calls } = createDeps()

  const result = activateModelKey(deps, 'other')

  assert.ok(result.ok)
  assert.deepEqual(result.model, { key: 'other', model: 'other-model', providerName: 'anthropic' })
  assert.deepEqual(calls.created, [{ modelKey: 'other', sessionId: 'session-1', recordCount: 2 }])
  assert.equal(calls.clearedCachedSections, 1,
    'the cached Environment section embeds the model name, so a stale prefix would survive')
  assert.deepEqual(calls.replaced, ['other'])
  assert.equal(calls.reappliedEffort, 1, 'effort has to be re-clamped to the new model maxEffort')
})

test('activateModelKey leaves the runtime alone for a key that is not configured', () => {
  const { deps, calls } = createDeps()

  const result = activateModelKey(deps, 'ghost')

  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('Unknown model: ghost'))
  // The three tier names are offerable whether or not they are keys.
  assert.deepEqual(!result.ok && result.availableModels,
    ['current', 'other', 'fastModel', 'fast', 'balanced', 'powerful'])
  assert.deepEqual(calls.replaced, [])
  assert.equal(calls.clearedCachedSections, 0, 'a refused switch must not invalidate the prompt cache')
})

test('activateModelKey turns a construction failure into a message, not a throw', () => {
  const { deps, calls } = createDeps({ createRuntimeThrows: 'no API key for endpoint "x"' })

  const result = activateModelKey(deps, 'other')

  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('no API key'))
  assert.deepEqual(calls.replaced, [])
})

test('switchModel persists the tier when the input names one', () => {
  const { deps, calls } = createDeps({
    resolveModelInput: (input) => (input === 'fast' ? 'fastModel' : input),
  })

  const result = switchModel(deps, 'fast')

  assert.ok(result.ok)
  assert.equal(result.model.key, 'fastModel')
  assert.deepEqual(calls.defaultModels, ['fast'], 'this is what set-model deliberately does not do')
  assert.equal(calls.saves, 1)
})

test('switchModel falls back to the tier the model happens to sit in', () => {
  const { deps, calls } = createDeps({ findTierForModel: () => 'balanced' })

  const result = switchModel(deps, 'other')

  assert.ok(result.ok)
  assert.deepEqual(calls.defaultModels, ['balanced'])
})

test('switchModel persists nothing when the model belongs to no tier', () => {
  const { deps, calls } = createDeps()

  assert.ok(switchModel(deps, 'other').ok)
  assert.deepEqual(calls.defaultModels, [])
  assert.equal(calls.saves, 0)
})

test('switchModel does not persist a tier for a switch that failed', () => {
  const { deps, calls } = createDeps({
    findTierForModel: () => 'balanced',
    createRuntimeThrows: 'boom',
  })

  assert.equal(switchModel(deps, 'other').ok, false)
  assert.deepEqual(calls.defaultModels, [], 'persisting here would leave config pointing at a model that failed')
})

test('switchModel explains inherit rather than calling it unknown', () => {
  const { deps } = createDeps({ resolveModelInput: () => undefined })

  const result = switchModel(deps, 'inherit')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('only valid in routing/subagent settings'))

  const other = switchModel(deps, 'sonnet-9')
  assert.ok(!other.ok && other.message.includes('Unknown model or tier: sonnet-9'))
})

test('a failed config save does not turn a live switch into a failure', async () => {
  const { deps, calls } = createDeps({ findTierForModel: () => 'balanced' })
  ;(deps.config as unknown as { save: () => Promise<void> }).save = async () => {
    calls.saves += 1
    throw new Error('disk full')
  }

  // The slot already took the change; a preference that did not persist is not
  // a failed switch, and the rejection must not surface as an unhandled one.
  assert.ok(switchModel(deps, 'other').ok)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.saves, 1)
})
