import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnterPlanProxy } from '../src/tui/hooks/useEnterPlanPermission.js'

/**
 * Unit tests for the imperative half of `useEnterPlanPermission` — the part
 * that lives outside React. The hook itself is exercised end-to-end through
 * planModeManager.test.ts via the openEnterPrompt dependency. Here we verify:
 *   - Pre-mount fallback auto-approves so headless callers (CI, unit tests
 *     calling PlanModeManager directly) can drive plan-mode entry without
 *     needing a React tree.
 *   - setOpen replaces the resolver, and subsequent open() calls go through
 *     the new function.
 */

test('createEnterPlanProxy: pre-mount fallback auto-approves entry', async () => {
  const proxy = createEnterPlanProxy()
  const result = await proxy.open()
  assert.equal(result, true, 'auto-approves so PlanModeManager fallback path stays compatible')
})

test('createEnterPlanProxy: setOpen swaps the resolver', async () => {
  const proxy = createEnterPlanProxy()
  const calls: number[] = []
  let nextResponse = false
  proxy.setOpen(async () => {
    calls.push(calls.length)
    return nextResponse
  })

  const r1 = await proxy.open()
  assert.equal(r1, false)
  assert.equal(calls.length, 1)

  nextResponse = true
  const r2 = await proxy.open()
  assert.equal(r2, true)
  assert.equal(calls.length, 2)
})

test('createEnterPlanProxy: subsequent setOpen replaces previous resolver', async () => {
  const proxy = createEnterPlanProxy()
  let firstCalled = false
  let secondCalled = false
  proxy.setOpen(async () => { firstCalled = true; return true })
  proxy.setOpen(async () => { secondCalled = true; return false })
  const result = await proxy.open()
  assert.equal(firstCalled, false, 'first resolver is discarded when replaced')
  assert.equal(secondCalled, true)
  assert.equal(result, false)
})
