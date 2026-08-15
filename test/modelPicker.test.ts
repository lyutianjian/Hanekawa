import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelPickerOptions } from '../src/runtime/modelPicker.js'
import type { ConfigService } from '../src/config/service.js'

/**
 * This ran inside `App.tsx` with no coverage of its own until it moved into
 * `src/runtime/`. The stub deliberately folds `apiKey`/`baseUrl` into what
 * `getModel` returns, exactly as `resolveModel` does, because keeping those out
 * of the result is the reason the function is host-side at all.
 */

interface StubOptions {
  models?: Record<string, unknown>
  defaultModel?: string
  profile?: Record<string, string>
  /** Keys `getModel` refuses to resolve, as a broken endpoint reference would. */
  unresolvable?: string[]
}

function stubConfig(options: StubOptions = {}): ConfigService {
  const models = options.models ?? { fast: {}, main: {}, big: {} }
  const unresolvable = new Set(options.unresolvable ?? [])
  return {
    get: () => ({ models, defaultModel: options.defaultModel ?? 'main' }),
    getModel: (key: string) =>
      unresolvable.has(key) || !(key in models)
        ? undefined
        : {
          model: `${key}-model`,
          provider: 'anthropic',
          contextWindow: 200_000,
          apiKey: 'SECRET',
          baseUrl: 'https://secret.example.com',
        },
    resolveModelReference: (reference: string | undefined) => reference,
    getActiveProfile: () =>
      options.profile === undefined
        ? undefined
        : { name: 'p', profile: options.profile },
  } as unknown as ConfigService
}

const keys = (options: StubOptions = {}) => Object.keys(options.models ?? { fast: {}, main: {}, big: {} })

test('there is exactly one option per tier, in cycle order', () => {
  const options = buildModelPickerOptions(stubConfig(), 'main', keys())
  assert.deepEqual(options.map((option) => option.tier), ['fast', 'balanced', 'powerful'])
  assert.deepEqual(options.map((option) => option.label), ['Fast', 'Balanced', 'Powerful'])
})

test('a routed tier resolves to its own model', () => {
  const profile = { fast: 'fast', balanced: 'main', powerful: 'big' }
  const options = buildModelPickerOptions(stubConfig({ profile }), 'main', keys())
  assert.deepEqual(options.map((option) => option.modelKey), ['fast', 'main', 'big'])
  assert.deepEqual(options.map((option) => option.modelId), ['fast-model', 'main-model', 'big-model'])
})

test('isCurrent and isDefault mark the active and configured models', () => {
  const profile = { fast: 'fast', balanced: 'main', powerful: 'big' }
  const options = buildModelPickerOptions(stubConfig({ profile, defaultModel: 'big' }), 'fast', keys())
  assert.deepEqual(options.map((option) => option.isCurrent), [true, false, false])
  assert.deepEqual(options.map((option) => option.isDefault), [false, false, true])
})

test('an unroutable tier falls back to the current model, then to the default', () => {
  // resolveTierModelKey's three steps, exercised through the public function.
  const noProfile = buildModelPickerOptions(stubConfig(), 'big', keys())
  assert.deepEqual(noProfile.map((option) => option.modelKey), ['big', 'big', 'big'])

  // With no usable current model either, every tier lands on defaultModel.
  const defaulted = buildModelPickerOptions(stubConfig({ defaultModel: 'main' }), 'gone', keys())
  assert.deepEqual(defaulted.map((option) => option.modelKey), ['main', 'main', 'main'])
})

test('a tier resolving outside the known keys is disabled', () => {
  const profile = { fast: 'fast', balanced: 'main', powerful: 'big' }
  // `big` resolves but the caller does not list it: App passes React state that
  // can legitimately lag behind config.
  const options = buildModelPickerOptions(stubConfig({ profile }), 'main', ['fast', 'main'])
  assert.equal(options[2]?.disabledReason, 'No configured model resolves for this tier.')
  assert.equal(options[2]?.modelKey, undefined)
  assert.equal(options[2]?.isCurrent, false)
  assert.equal(options[2]?.isDefault, false)
})

test('a known key that will not load is a distinguishable failure', () => {
  // Reached only when getModel goes from resolvable to not between the two
  // calls, so the two disabled branches stay separately diagnosable.
  const config = stubConfig()
  let calls = 0
  const flaky = {
    ...config,
    getModel: (key: string) => (key === 'main' && ++calls > 1 ? undefined : config.getModel(key)),
  } as unknown as ConfigService

  const options = buildModelPickerOptions(flaky, 'main', keys())
  assert.equal(options[0]?.disabledReason, 'Configured model "main" could not be loaded.')
  assert.notEqual(options[0]?.disabledReason, 'No configured model resolves for this tier.')
})

test('providerName falls back to unknown', () => {
  const config = stubConfig()
  const anonymous = {
    ...config,
    getModel: (key: string) => ({ model: `${key}-model` }),
  } as unknown as ConfigService
  assert.equal(buildModelPickerOptions(anonymous, 'main', keys())[0]?.providerName, 'unknown')
})

test('the result crosses the wire and carries no credentials', () => {
  const profile = { fast: 'fast', balanced: 'main', powerful: 'big' }
  const options = buildModelPickerOptions(stubConfig({ profile }), 'main', keys())

  const serialized = JSON.stringify(structuredClone(options))
  assert.ok(!serialized.includes('SECRET'), 'apiKey must not reach a renderer')
  assert.ok(!serialized.includes('secret.example.com'), 'baseUrl must not reach a renderer')
})
