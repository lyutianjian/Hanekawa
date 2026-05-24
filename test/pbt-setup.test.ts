import { describe, it } from 'node:test'
import assert from 'node:assert'
import fc from 'fast-check'

/**
 * Verifies that fast-check is properly installed and integrates with
 * the Node.js built-in test runner. Also confirms minimum 100 iterations.
 */
describe('fast-check setup verification', () => {
  it('fast-check runs property tests with node:test', () => {
    let iterations = 0
    fc.assert(
      fc.property(fc.integer(), (n) => {
        iterations++
        return typeof n === 'number' && Number.isInteger(n)
      }),
      { numRuns: 100 }
    )
    assert(iterations >= 100, `Expected at least 100 iterations, got ${iterations}`)
  })

  it('fast-check reports counterexamples on failure', () => {
    assert.throws(
      () => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: 1000 }), (n) => {
            return n < 0 // always false for non-negative
          }),
          { numRuns: 100 }
        )
      },
      (err: unknown) => {
        return err instanceof Error && err.message.includes('Property failed')
      }
    )
  })

  it('supports arbitrary string generation for property tests', () => {
    let iterations = 0
    fc.assert(
      fc.property(fc.string(), (s) => {
        iterations++
        return typeof s === 'string'
      }),
      { numRuns: 100 }
    )
    assert(iterations >= 100, `Expected at least 100 iterations, got ${iterations}`)
  })
})
