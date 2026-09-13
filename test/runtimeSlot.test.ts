import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { AgentSession } from '../src/runtime/types.js'
import type { ModelConfig } from '../src/config/service.js'
import type { EffortLevel } from '../src/config/effort.js'

interface Trace {
  disposed: string[]
  efforts: Array<EffortLevel | undefined>
}

function createTrace(): Trace {
  return { disposed: [], efforts: [] }
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { provider: 'anthropic', model: 'claude-test', ...overrides } as ModelConfig
}

function session(
  key: string,
  trace: Trace,
  modelConfig = model(),
  onDispose?: () => void,
): AgentSession {
  return {
    loop: {
      setEffort: (level: EffortLevel | undefined) => { trace.efforts.push(level) },
    },
    planModeManager: {},
    modelKey: key,
    modelConfig,
    providerName: 'anthropic',
    run: async () => ({ content: '', usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } }),
    dispose: () => {
      onDispose?.()
      trace.disposed.push(key)
    },
  } as unknown as AgentSession
}

test('the outgoing runtime is disposed only after the incoming one is already live', () => {
  const trace = createTrace()
  let slot!: RuntimeSlot
  const seenDuringDispose: string[] = []
  // A late dispose must not be able to tear down the runtime that replaced it,
  // so by the time it runs the slot must already report the new runtime.
  const first = session('a', trace, model(), () => {
    seenDuringDispose.push(slot.requireCurrent().modelKey)
  })
  slot = new RuntimeSlot(first, 'high')

  slot.replace(session('b', trace))

  assert.deepEqual(seenDuringDispose, ['b'])
  assert.deepEqual(trace.disposed, ['a'])
  assert.equal(slot.requireCurrent().modelKey, 'b')
})

test('replace notifies subscribers exactly once and is a no-op for the same runtime', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace), 'high')
  let notifications = 0
  slot.subscribe(() => { notifications += 1 })

  slot.replace(session('b', trace))
  assert.equal(notifications, 1)

  slot.replace(slot.current)
  assert.equal(notifications, 1)
  assert.deepEqual(trace.disposed, ['a'])
})

test('the snapshot identity only changes when the runtime or effort changes', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace, model({ supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })), 'high')
  const before = slot.getSnapshot()

  slot.setEffort('high')
  assert.equal(slot.getSnapshot(), before)

  slot.setEffort('low')
  assert.notEqual(slot.getSnapshot(), before)
  assert.equal(slot.getSnapshot().effort, 'low')
})

test('patchModel swaps metadata without disposing or rebuilding the loop', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace), 'high')
  const loop = slot.requireCurrent().loop

  slot.patchModel('b', model({ model: 'claude-fallback' }), 'anthropic')

  assert.equal(slot.requireCurrent().modelKey, 'b')
  assert.equal(slot.requireCurrent().modelConfig.model, 'claude-fallback')
  // Same loop object: a fallback keeps running on the runtime that started the turn.
  assert.equal(slot.requireCurrent().loop, loop)
  assert.deepEqual(trace.disposed, [])

  let notifications = 0
  slot.subscribe(() => { notifications += 1 })
  slot.patchModel('b', model(), 'anthropic')
  assert.equal(notifications, 0)
})

test('effort is clamped to the active model and re-clamped after a runtime swap', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace, model({ supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })), 'high')

  assert.equal(slot.setEffort('max'), 'max')
  assert.deepEqual(trace.efforts, ['max'])

  slot.replace(session('b', trace, model({ supportedEfforts: ['low', 'medium'] })))
  assert.equal(slot.reapplyEffort(), 'medium')
  assert.equal(slot.getEffort(), 'medium')
  // The clamp is applied to the *new* loop, not the disposed one.
  assert.deepEqual(trace.efforts, ['max', 'medium'])
})

test('a model without a supportedEfforts restriction leaves effort untouched', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace, model()), 'high')

  assert.equal(slot.setEffort('max'), 'max')
  assert.equal(slot.getEffort(), 'max')
  assert.deepEqual(trace.efforts, ['max'])
})

test('dispose tears down the live runtime', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(session('a', trace), 'high')
  slot.dispose()
  assert.deepEqual(trace.disposed, ['a'])
})

test('a slot can enter setup, activate a model, and return to setup without stale runtimes', () => {
  const trace = createTrace()
  const slot = new RuntimeSlot(undefined, 'high')
  assert.equal(slot.getSnapshot().status, 'needs_configuration')
  assert.throws(() => slot.requireCurrent(), /\/provider/)
  slot.setEffort('max')

  slot.replace(session('first', trace, model({ supportedEfforts: ['low', 'medium'] })))
  slot.reapplyEffort()
  assert.equal(slot.getSnapshot().status, 'ready')
  assert.equal(slot.getEffort(), 'medium')

  slot.replace(undefined)
  assert.equal(slot.current, undefined)
  assert.deepEqual(trace.disposed, ['first'])
  slot.patchModel('late-event', model())
  assert.equal(slot.current, undefined)

  slot.replace(session('second', trace))
  assert.equal(slot.requireCurrent().modelKey, 'second')
  slot.dispose()
  assert.deepEqual(trace.disposed, ['first', 'second'])
})
