import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentCacheSource,
  checkResponseForCacheBreak,
  planCacheSource,
  recordPromptState,
  resetCacheBreakDetection,
} from '../src/harness/cacheBreakDetection.js'

const MAIN = agentCacheSource('s1')
const PLAN = planCacheSource('s1')

test('planCacheSource produces a distinct source from agentCacheSource for the same id', () => {
  assert.notEqual(MAIN, PLAN)
  assert.match(PLAN, /^agent:plan:s1$/)
})

test('plan tier requests do not flip modelChanged on the main snapshot', () => {
  resetCacheBreakDetection()

  // Main-loop request with model A.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'main-model' }, MAIN)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN), null)

  // User enters plan mode: the loop now routes the request through PLAN
  // with a different model. Without isolation this would be recorded on
  // MAIN and trigger modelChanged on the next MAIN turn.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan-model' }, PLAN)
  // Plan source has its own first-time baseline, not classified as a break.
  assert.equal(checkResponseForCacheBreak(0, 1_000, PLAN), null)

  // User exits plan mode and the next main-loop turn happens. cache_read
  // drops a lot (let's say compaction or eviction), but the cause should
  // NOT include model_changed because main never saw a different model.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'main-model' }, MAIN)
  const result = checkResponseForCacheBreak(0, 1_000, MAIN)

  if (result) {
    assert.ok(
      !result.reasons.some((reason) => reason.startsWith('model_changed')),
      `expected no model_changed in main reasons, got ${result.reasons.join(', ')}`,
    )
  }
})

test('repeated plan-mode entries reuse the plan-tier baseline', () => {
  resetCacheBreakDetection()

  // First plan-mode entry.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan-model' }, PLAN)
  assert.equal(checkResponseForCacheBreak(80_000, 1_000, PLAN), null)

  // Some main-loop activity in between (separate source).
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'main-model' }, MAIN)
  // ... main read goes here, irrelevant for plan source state.

  // Second plan-mode entry: same model, same prompts. Should NOT report
  // modelChanged (we never saw a different model on the plan source) and
  // should be a normal continuation of the plan-tier cache stream.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan-model' }, PLAN)
  const result = checkResponseForCacheBreak(78_000, 1_000, PLAN)
  // Drop is 2000, but >=95% retained so the detector returns null
  // (no break).
  assert.equal(result, null)
})

test('plan source reports its own modelChanged when plan tier itself changes model', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan-a' }, PLAN)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, PLAN), null)

  // User edits the plan tier mapping mid-session.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan-b' }, PLAN)
  const result = checkResponseForCacheBreak(0, 1_000, PLAN)
  assert.ok(result)
  assert.ok(result.reasons.includes('model_changed'))
})

test('clearing without args wipes plan and main snapshots together', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'main' }, MAIN)
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan' }, PLAN)

  resetCacheBreakDetection()

  // After reset, both sources start fresh: first recordPromptState produces
  // no `previous`, so subsequent checkResponseForCacheBreak returns null
  // because prevCacheReadTokens is null.
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'main' }, MAIN)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN), null)
  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'plan' }, PLAN)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, PLAN), null)
})
