import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemPromptSectionCache } from '../src/harness/sections.js'

test('cachedSection computes once until cleared', () => {
  const sections = new SystemPromptSectionCache()
  let calls = 0

  const first = sections.cachedSection('static', () => {
    calls++
    return 'value'
  })
  const second = sections.cachedSection('static', () => {
    calls++
    return 'changed'
  })

  assert.equal(first, 'value')
  assert.equal(second, 'value')
  assert.equal(calls, 1)

  sections.clear('static')
  const third = sections.cachedSection('static', () => {
    calls++
    return 'changed'
  })

  assert.equal(third, 'changed')
  assert.equal(calls, 2)
})

test('uncachedSection computes every time', () => {
  const sections = new SystemPromptSectionCache()
  let calls = 0

  const first = sections.uncachedSection('date', 'wall clock changes between turns', () => {
    calls++
    return `value-${calls}`
  })
  const second = sections.uncachedSection('date', 'wall clock changes between turns', () => {
    calls++
    return `value-${calls}`
  })

  assert.equal(first, 'value-1')
  assert.equal(second, 'value-2')
  assert.equal(calls, 2)
})

test('section caches are isolated per instance', () => {
  const left = new SystemPromptSectionCache()
  const right = new SystemPromptSectionCache()

  assert.equal(left.cachedSection('key', () => 'left'), 'left')
  assert.equal(right.cachedSection('key', () => 'right'), 'right')
})
