import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { waitForCondition, type WaitCondition, type WaitDeps } from '../src/desktop/browser/wait.js'

/**
 * The wait loop, driven by a fake clock.
 *
 * Real sleeping would make these tests slow and flaky in the same stroke, and
 * the behaviour under test is arithmetic anyway: when it polls, what it keeps
 * from each observation, and which of the two failures it is allowed to turn
 * into a timeout.
 */

interface Observation {
  matched: boolean
  observed: string
}

function harness(options: {
  observations: Array<Observation | Error>
  timeoutMs?: number
  generations?: Array<number | undefined>
}): { deps: WaitDeps; polls: () => number; elapsed: () => number } {
  let index = 0
  let clock = 0
  let generationIndex = 0

  const deps: WaitDeps = {
    timeoutMs: options.timeoutMs ?? 1000,
    evaluate: async () => {
      const next = options.observations[Math.min(index, options.observations.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return { ok: true, value: { ...next, url: 'https://x.test/', title: 'X' } }
    },
    generation: () => {
      const list = options.generations
      if (list === undefined) return 1
      const value = list[Math.min(generationIndex, list.length - 1)]
      generationIndex += 1
      return value
    },
    check: () => undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, polls: () => index, elapsed: () => clock }
}

const condition: WaitCondition = { selector: '#done' }

test('a condition already met answers on the first poll', async () => {
  const { deps, polls, elapsed } = harness({ observations: [{ matched: true, observed: '#done is visible' }] })
  const result = await waitForCondition(deps, condition)
  assert.match(result.text, /#done is visible\. url=https:\/\/x\.test\/ title=X/)
  assert.equal(polls(), 1)
  assert.equal(elapsed(), 0, 'nothing may sleep once the answer is in')
})

test('an unmet condition is polled until it holds', async () => {
  const { deps, polls, elapsed } = harness({
    observations: [
      { matched: false, observed: 'still loading' },
      { matched: false, observed: 'still loading' },
      { matched: true, observed: '#done is visible' },
    ],
  })
  await waitForCondition(deps, condition)
  assert.equal(polls(), 3)
  assert.equal(elapsed(), 200)
})

test('a timeout carries the last thing actually seen', async () => {
  const { deps } = harness({
    observations: [{ matched: false, observed: '"Loaded" is not visible in the page' }],
    timeoutMs: 300,
  })
  await assert.rejects(
    () => waitForCondition(deps, condition),
    (error: unknown) => {
      assert.ok(error instanceof BrowserHostError)
      assert.equal(error.code, 'WAIT_TIMEOUT')
      assert.match(error.message, /within 300ms/)
      assert.match(error.message, /Last seen: "Loaded" is not visible in the page/)
      assert.equal((error as unknown as { lastObserved: string }).lastObserved, '"Loaded" is not visible in the page')
      return true
    },
  )
})

test('a timeout before any observation says exactly that', async () => {
  const { deps } = harness({
    observations: [Object.assign(new Error('The page could not be read.'), { retryable: true })],
    timeoutMs: 100,
  })
  await assert.rejects(
    () => waitForCondition(deps, condition),
    (error: unknown) => error instanceof BrowserHostError && /Last seen: The page could not be read/.test(error.message),
  )

  const silent = harness({ observations: [{ matched: false, observed: '' }], timeoutMs: 0 })
  // A zero budget still polls once: the answer may already be true.
  await assert.rejects(() => waitForCondition(silent.deps, condition))
})

test('a page that cannot answer yet is waited out; one that never will is not', async () => {
  const retryable = harness({
    observations: [
      Object.assign(new Error('The page has not finished loading.'), { retryable: true }),
      { matched: true, observed: '#done is visible' },
    ],
  })
  const result = await waitForCondition(retryable.deps, condition)
  assert.match(result.text, /#done is visible/)

  const fatal = harness({
    observations: [new BrowserHostError('INVALID_REQUEST', 'not a usable CSS selector: #)')],
  })
  await assert.rejects(
    () => waitForCondition(fatal.deps, condition),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('a navigation mid-wait is noted rather than treated as a failure', async () => {
  const { deps } = harness({
    observations: [
      { matched: false, observed: 'no element matches #done' },
      { matched: true, observed: '#done is visible' },
    ],
    generations: [4, 5],
  })
  const result = await waitForCondition(deps, condition)
  assert.match(result.text, /the document changed while waiting/)
})

test('a wait with nothing to wait for is refused', async () => {
  const { deps } = harness({ observations: [{ matched: true, observed: 'x' }] })
  await assert.rejects(
    () => waitForCondition(deps, {}),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('an already aborted wait stops before it asks the page anything', async () => {
  const { deps, polls } = harness({ observations: [{ matched: true, observed: 'x' }] })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => waitForCondition({ ...deps, signal: controller.signal }, condition),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
  assert.equal(polls(), 0)
})
