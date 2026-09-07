import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampEffort, normalizeSupportedEfforts } from '../src/config/effort.js'

/**
 * `supportedEfforts` is a *set*, not the ceiling it replaced. The cases below
 * are the ones a ceiling could not express: a gap in the middle of the ladder,
 * and a floor above the level being asked for.
 */

test('a supported level is returned unchanged', () => {
  assert.equal(clampEffort('medium', ['low', 'medium']), 'medium')
  assert.equal(clampEffort('max', undefined), 'max')
})

test('an unsupported level falls to the highest supported level below it', () => {
  assert.equal(clampEffort('max', ['low', 'medium', 'high']), 'high')
  // The gap case: `medium` is missing from the middle, so `low` is the answer
  // even though `high` is also supported.
  assert.equal(clampEffort('medium', ['low', 'high']), 'low')
})

test('a level below everything supported rises to the lowest supported one', () => {
  assert.equal(clampEffort('low', ['high', 'max']), 'high')
})

test('a numeric effort is a token budget and is never moved', () => {
  assert.equal(clampEffort(32_000, ['low']), 32_000)
})

test('normalize collapses "nothing" and "everything" to no restriction', () => {
  assert.equal(normalizeSupportedEfforts([]), undefined)
  assert.equal(normalizeSupportedEfforts(['low', 'medium', 'high', 'xhigh', 'max']), undefined)
  assert.equal(normalizeSupportedEfforts(undefined), undefined)
})

test('normalize drops unknown levels, dedupes, and sorts by rank', () => {
  assert.deepEqual(normalizeSupportedEfforts(['high', 'low', 'high', 'nope']), ['low', 'high'])
})
