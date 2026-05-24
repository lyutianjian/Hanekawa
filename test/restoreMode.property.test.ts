import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 3: Checkpoint list ordering and formatting.
 *
 * Validates: Requirements 2.2
 *
 * For any non-empty checkpoint list:
 *   - displayed order is reverse chronological (newest first)
 *   - each entry's message content is at most 80 characters
 *   - each entry includes a timestamp
 *
 * Strategy: test the pure sorting and formatting logic that RestoreMode uses
 * without rendering React/ink components.
 */

interface Checkpoint {
  commitHash: string
  messageId: string
  messageContent: string
  timestamp: string
}

/**
 * Replicates the sorting logic from RestoreMode.tsx:
 *   [...checkpoints].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
 */
function sortCheckpointsReverseChronological(checkpoints: Checkpoint[]): Checkpoint[] {
  return [...checkpoints].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )
}

/**
 * Replicates the truncation logic from RestoreMode.tsx:
 *   content.length <= maxLength ? content : content.slice(0, maxLength - 1) + '…'
 */
function truncateMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return content.slice(0, maxLength - 1) + '…'
}

/**
 * Replicates the timestamp formatting from RestoreMode.tsx.
 */
function formatLocalTimestamp(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp)
    if (isNaN(date.getTime())) return isoTimestamp
    return date.toLocaleString()
  } catch {
    return isoTimestamp
  }
}

/** Generate a random ISO timestamp within a reasonable range. */
const isoTimestampArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString())

/** Generate a random Checkpoint. */
const checkpointArb: fc.Arbitrary<Checkpoint> = fc.record({
  commitHash: fc.hexaString({ minLength: 40, maxLength: 40 }),
  messageId: fc.uuid(),
  messageContent: fc.string({ maxLength: 200 }),
  timestamp: isoTimestampArb,
})

describe('Property 3: checkpoint list ordering and formatting', () => {
  it('for any non-empty checkpoint list, sorted order is reverse chronological', () => {
    fc.assert(
      fc.property(
        fc.array(checkpointArb, { minLength: 1, maxLength: 20 }),
        (checkpoints) => {
          const sorted = sortCheckpointsReverseChronological(checkpoints)

          // Verify reverse chronological: each timestamp >= the next one
          for (let i = 0; i < sorted.length - 1; i++) {
            const current = new Date(sorted[i]!.timestamp).getTime()
            const next = new Date(sorted[i + 1]!.timestamp).getTime()
            if (current < next) return false
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any checkpoint, the displayed message content is at most 80 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (content) => {
          const truncated = truncateMessage(content, 80)
          return truncated.length <= 80
        },
      ),
      { numRuns: 100 },
    )
  })

  it('truncation preserves content when it is already <= 80 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        (content) => {
          const truncated = truncateMessage(content, 80)
          return truncated === content
        },
      ),
      { numRuns: 100 },
    )
  })

  it('truncation adds ellipsis when content exceeds 80 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 81, maxLength: 500 }),
        (content) => {
          const truncated = truncateMessage(content, 80)
          return (
            truncated.length === 80 &&
            truncated.endsWith('…') &&
            truncated.slice(0, 79) === content.slice(0, 79)
          )
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any valid ISO timestamp, formatLocalTimestamp returns a non-empty string', () => {
    fc.assert(
      fc.property(isoTimestampArb, (ts) => {
        const formatted = formatLocalTimestamp(ts)
        return formatted.length > 0
      }),
      { numRuns: 100 },
    )
  })

  it('the sorted list has the same length as the input', () => {
    fc.assert(
      fc.property(
        fc.array(checkpointArb, { minLength: 0, maxLength: 20 }),
        (checkpoints) => {
          const sorted = sortCheckpointsReverseChronological(checkpoints)
          return sorted.length === checkpoints.length
        },
      ),
      { numRuns: 100 },
    )
  })
})
