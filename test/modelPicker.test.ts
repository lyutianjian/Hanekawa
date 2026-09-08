import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelPickerOptions, type ModelPickerConfig } from '../src/runtime/modelPicker.js'

/**
 * This ran inside `App.tsx` with no coverage of its own until it moved into
 * `src/runtime/`. The stub deliberately folds `apiKey`/`baseUrl` into what
 * `getModel` returns, exactly as `resolveModel` does, because keeping those out
 * of the result is the reason the function is host-side at all.
 *
 * Typed as `ModelPickerConfig` rather than cast to `ConfigService`: with no
 * `as unknown as` in the way, the compiler still checks the fake against every
 * member the builder calls.
 */

interface StubOptions {
  models?: Record<string, { provider?: string; supportsImageInput?: boolean }>
  defaultModel?: string
  /** Keys `getModel` refuses to resolve, as a broken endpoint reference would. */
  unresolvable?: string[]
}

const DEFAULT_MODELS: Record<string, { provider?: string; supportsImageInput?: boolean }> = {
  small: {},
  main: {},
  big: {},
}

function stubConfig(options: StubOptions = {}): ModelPickerConfig {
  const models = options.models ?? DEFAULT_MODELS
  const unresolvable = new Set(options.unresolvable ?? [])
  return {
    get: () => ({ defaultModel: options.defaultModel ?? 'main' }),
    getModel: (key: string) =>
      unresolvable.has(key) || !(key in models)
        ? undefined
        : {
          model: `${key}-model`,
          provider: 'anthropic',
          contextWindow: 200_000,
          apiKey: 'SECRET',
          baseUrl: 'https://secret.example.com',
          ...models[key],
        },
    resolveModelReference: (reference: string | undefined) => reference,
  }
}

const keys = (options: StubOptions = {}) => Object.keys(options.models ?? DEFAULT_MODELS)

test('there is exactly one option per configured model key, in the order given', () => {
  const options = buildModelPickerOptions(stubConfig(), 'main', keys())
  assert.deepEqual(options.map((option) => option.key), ['small', 'main', 'big'])
  // The key is the label: with tiers gone there is no other name for a row.
  assert.deepEqual(options.map((option) => option.label), ['small', 'main', 'big'])
})

test('each row carries its own model key and id', () => {
  const options = buildModelPickerOptions(stubConfig(), 'main', keys())
  assert.deepEqual(options.map((option) => option.modelKey), ['small', 'main', 'big'])
  assert.deepEqual(options.map((option) => option.modelId), ['small-model', 'main-model', 'big-model'])
  assert.deepEqual(options.map((option) => option.providerName), ['anthropic', 'anthropic', 'anthropic'])
})

test('isCurrent and isDefault mark the active and configured models', () => {
  const options = buildModelPickerOptions(stubConfig({ defaultModel: 'big' }), 'small', keys())
  assert.deepEqual(options.map((option) => option.isCurrent), [true, false, false])
  assert.deepEqual(options.map((option) => option.isDefault), [false, false, true])
})

test('the caller decides which keys are listed', () => {
  // `App` passes React state that can legitimately lag behind config, so the
  // key list is an argument rather than something read back out of the service.
  const options = buildModelPickerOptions(stubConfig(), 'main', ['main', 'big'])
  assert.deepEqual(options.map((option) => option.key), ['main', 'big'])
})

test('an empty key list yields no rows rather than a placeholder', () => {
  assert.deepEqual(buildModelPickerOptions(stubConfig(), 'main', []), [])
})

test('a key that will not load is listed, disabled, and says why', () => {
  const options = buildModelPickerOptions(stubConfig({ unresolvable: ['main'] }), 'main', keys())
  const broken = options[1]!
  assert.equal(broken.key, 'main')
  assert.equal(broken.disabledReason, 'Configured model "main" could not be loaded.')
  assert.equal(broken.modelKey, undefined)
  assert.equal(broken.modelId, undefined)
  // A row that cannot be chosen is never the current or default one.
  assert.equal(broken.isCurrent, false)
  assert.equal(broken.isDefault, false)
  // Its neighbours are unaffected.
  assert.equal(options[0]?.disabledReason, undefined)
  assert.equal(options[2]?.disabledReason, undefined)
})

test('providerName falls back to unknown', () => {
  const anonymous: ModelPickerConfig = {
    get: () => ({ defaultModel: 'main' }),
    getModel: (key: string) => ({ model: `${key}-model` }),
    resolveModelReference: (reference) => reference,
  }
  assert.equal(buildModelPickerOptions(anonymous, 'main', keys())[0]?.providerName, 'unknown')
})

test('the result crosses the wire and carries no credentials', () => {
  const options = buildModelPickerOptions(stubConfig(), 'main', keys())

  const serialized = JSON.stringify(structuredClone(options))
  assert.ok(!serialized.includes('SECRET'), 'apiKey must not reach a renderer')
  assert.ok(!serialized.includes('secret.example.com'), 'baseUrl must not reach a renderer')
})

test('rows carry the effective image capability, not the raw switch', () => {
  const options = buildModelPickerOptions(
    stubConfig({
      models: {
        vision: { supportsImageInput: true },
        off: { supportsImageInput: false },
        // A non-boolean switch is off, same as resolveImageCapability.
        stringy: { supportsImageInput: 'true' as never },
        unlisted: {},
        // Switch on, but the provider's adapter does not implement image input.
        future: { provider: 'made-up', supportsImageInput: true },
      },
    }),
    'vision',
    ['vision', 'off', 'stringy', 'unlisted', 'future'],
  )

  // Absent rather than `false`: the field only crosses the wire when true, so
  // `option.supportsImageInput === true` is the whole marker contract.
  assert.deepEqual(
    options.map((option) => option.supportsImageInput),
    [true, undefined, undefined, undefined, undefined],
  )
  // The raw switch never reaches the wire on its own: a non-boolean value does
  // not ride along under the same name.
  assert.equal('supportsImageInput' in (options[2] ?? {}), false)
})
