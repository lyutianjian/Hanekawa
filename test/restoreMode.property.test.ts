import { describe, it } from 'node:test'
import fc from 'fast-check'
import {
  sortCheckpointsChronological,
  sortCheckpointsReverseChronological,
  truncateMessage,
} from '../src/tui/components/RestoreMode.js'
import type { CheckpointWithDiff } from '../src/services/checkpoint/checkpointService.js'

const emptyDiff = {
  fileCount: 0,
  additions: 0,
  deletions: 0,
  hasChanges: false,
}

const isoTimestampArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString())

const checkpointArb: fc.Arbitrary<CheckpointWithDiff> = fc.record({
  commitHash: fc.hexaString({ minLength: 40, maxLength: 40 }),
  messageId: fc.uuid(),
  messageContent: fc.string({ maxLength: 200 }),
  timestamp: isoTimestampArb,
  turnDiff: fc.constant(emptyDiff),
  restoreDiff: fc.constant(emptyDiff),
  isCurrent: fc.boolean(),
})

describe('Property 3: rewind checkpoint list ordering and formatting', () => {
  it('for any checkpoint list, sorted order is reverse chronological', () => {
    fc.assert(
      fc.property(
        fc.array(checkpointArb, { minLength: 0, maxLength: 20 }),
        (checkpoints) => {
          const sorted = sortCheckpointsReverseChronological(checkpoints)
          for (let i = 0; i < sorted.length - 1; i++) {
            const current = new Date(sorted[i]!.timestamp).getTime()
            const next = new Date(sorted[i + 1]!.timestamp).getTime()
            if (current < next) return false
          }
          return sorted.length === checkpoints.length
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any checkpoint list, rewind choices are sorted chronologically', () => {
    fc.assert(
      fc.property(
        fc.array(checkpointArb, { minLength: 0, maxLength: 20 }),
        (checkpoints) => {
          const sorted = sortCheckpointsChronological(checkpoints)
          for (let i = 0; i < sorted.length - 1; i++) {
            const current = new Date(sorted[i]!.timestamp).getTime()
            const next = new Date(sorted[i + 1]!.timestamp).getTime()
            if (current > next) return false
          }
          return sorted.length === checkpoints.length
        },
      ),
      { numRuns: 100 },
    )
  })

  it('truncated message content is at most the requested length', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        fc.integer({ min: 3, max: 120 }),
        (content, maxLength) => truncateMessage(content, maxLength).length <= maxLength,
      ),
      { numRuns: 100 },
    )
  })

  it('truncation preserves content when it already fits', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        (content) => truncateMessage(content, 80) === content,
      ),
      { numRuns: 100 },
    )
  })

  it('truncation adds ASCII ellipsis when content exceeds the limit', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 81, maxLength: 500 }),
        (content) => {
          const truncated = truncateMessage(content, 80)
          return truncated.length === 80 && truncated.endsWith('...')
        },
      ),
      { numRuns: 100 },
    )
  })
})
