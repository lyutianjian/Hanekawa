import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_CRITICAL_RATIO,
  CONTEXT_WARN_RATIO,
  contextGaugeView,
  formatTokens,
  hiddenContextGauge,
  statusUsageView,
} from '../src/desktop/renderer/model/usage.js'
import type { TokenUsage } from '../src/harness/types.js'
import type { WireReadyRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The two token readouts, with no DOM — the `model/` half of the renderer's
 * split, same as `test/rendererComposerChip.test.ts`.
 */

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, ...overrides }
}

function runtime(overrides: Partial<WireReadyRuntimeSnapshot> = {}): WireReadyRuntimeSnapshot {
  return {
    status: 'ready',
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

test('token counts abbreviate without losing the leading digits', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(16_400), '16k')
  assert.equal(formatTokens(950_000), '950k')
  assert.equal(formatTokens(1_200_000), '1.2M')
})

test('an untouched session leaves the status line empty', () => {
  // `#status` has no reserved height: three empty flex items generate no line
  // box, so a fresh session must produce an empty string rather than a row of
  // zeros holding a band of dead space under the composer.
  for (const view of [statusUsageView(usage()), statusUsageView(undefined)]) {
    assert.deepEqual(view.metrics, [])
    assert.equal(view.rate, undefined)
    assert.equal(view.text, '')
    assert.equal(view.title, '')
  }
})

test('the status line sums all three counts into one total', () => {
  const view = statusUsageView(usage({
    inputTokens: 12_400,
    cacheReadInputTokens: 88_100,
    outputTokens: 3_200,
  }))
  // One chip on screen; its label lives in the accessible name beside it.
  assert.deepEqual(view.metrics.map((metric) => [metric.kind, metric.value]), [
    ['total', '104k tok'],
  ])
  // The rate is the one field written out on screen — no glyph explains a ratio.
  assert.deepEqual(view.rate, { label: '缓存命中', percent: '87.7%' })
  assert.equal(view.text, '总计 104k tok · 缓存命中 87.7%')
  // The hover still carries the split, unabbreviated.
  assert.match(view.title, /103,700/)
  assert.match(view.title, /12,400/)
  assert.match(view.title, /88,100/)
  assert.match(view.title, /3,200/)
})

test('the hit rate ignores output tokens', () => {
  // Output is generated and can never be served from cache; folding it into the
  // denominator would drag the number down for a reason nobody can act on.
  const view = statusUsageView(usage({
    inputTokens: 100,
    cacheReadInputTokens: 100,
    outputTokens: 1_000_000,
  }))
  assert.equal(view.rate?.percent, '50.0%')
})

test('a turn with no input side reports no rate at all', () => {
  const view = statusUsageView(usage({ outputTokens: 500 }))
  assert.equal(view.rate, undefined)
  assert.equal(view.text, '总计 500 tok')
})

test('the gauge is absent, not empty, when either number is missing', () => {
  const hiddenCases = [
    contextGaugeView(undefined, runtime({ usableContextWindow: 167_000 })),
    contextGaugeView(1000, runtime()),
    contextGaugeView(1000, undefined),
    contextGaugeView(1000, runtime({ usableContextWindow: 0 })),
  ]
  for (const view of hiddenCases) {
    assert.equal(view.visible, false)
    assert.equal(view.used, '')
    assert.equal(view.usable, '')
    assert.equal(view.modelWindow, undefined)
  }
  assert.equal(hiddenContextGauge().visible, false)
})

test('the gauge measures against the usable window, not the raw one', () => {
  // The denominator is the autocompact threshold: the turn that crosses it gets
  // compacted, so a percentage of the raw window would promise room no turn is
  // allowed to use. 16k of 167k is 10%; of 200k it would read 8%.
  const view = contextGaugeView(16_700, runtime({
    contextWindow: 200_000,
    usableContextWindow: 167_000,
  }))
  assert.equal(view.visible, true)
  assert.equal(view.percent, '10%')
  assert.equal(view.used, '17k')
  assert.equal(view.usable, '167k')
  assert.equal(view.modelWindow, '200k')
  assert.match(view.title, /10% 已用（剩余 90%）/)
  assert.match(view.title, /已用 17k 标记，共 167k/)
  assert.match(view.title, /模型窗口 200k/)
})

test('the gauge clamps rather than overflowing its ring', () => {
  const view = contextGaugeView(500_000, runtime({ usableContextWindow: 167_000 }))
  assert.equal(view.ratio, 1)
  assert.equal(view.percent, '100%')
})

test('the gauge changes level as autocompact approaches', () => {
  const at = (ratio: number) => contextGaugeView(
    Math.round(100_000 * ratio),
    runtime({ usableContextWindow: 100_000 }),
  ).level
  assert.equal(at(0.5), 'normal')
  assert.equal(at(CONTEXT_WARN_RATIO - 0.01), 'normal')
  assert.equal(at(CONTEXT_WARN_RATIO), 'warn')
  assert.equal(at(CONTEXT_CRITICAL_RATIO - 0.01), 'warn')
  assert.equal(at(CONTEXT_CRITICAL_RATIO), 'critical')
})

test('a model whose whole window is usable does not claim a separate reserve', () => {
  const view = contextGaugeView(10, runtime({ contextWindow: 1000, usableContextWindow: 1000 }))
  assert.equal(view.modelWindow, undefined)
  assert.doesNotMatch(view.title, /模型窗口/)
})
