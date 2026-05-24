import { describe, it } from 'node:test'
import fc from 'fast-check'

/**
 * Feature: keyboard-shortcuts-control
 *
 * Property 8: Restore success message formatting.
 *
 * Validates: Requirements 6.3
 *
 * For any message content and timestamp, the restore success message contains:
 *   - the first 50 chars of content
 *   - the formatted timestamp
 *
 * Strategy: test the pure formatting logic that App.tsx uses when displaying
 * the restore success system message.
 */

/**
 * Replicates the restore success message formatting from App.tsx:
 *   `Restored to "${messagePreview}" (${timestamp})`
 * where messagePreview = checkpoint.messageContent.slice(0, 50)
 * and timestamp = new Date(checkpoint.timestamp).toLocaleString()
 */
function formatRestoreSuccessMessage(messageContent: string, isoTimestamp: string): string {
  const messagePreview = messageContent.slice(0, 50)
  const timestamp = new Date(isoTimestamp).toLocaleString()
  return `Restored to "${messagePreview}" (${timestamp})`
}

/** Generate a random ISO timestamp within a reasonable range. */
const isoTimestampArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString())

describe('Property 8: restore success message formatting', () => {
  it('for any message content, the success message contains at most the first 50 chars of content', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        isoTimestampArb,
        (content, timestamp) => {
          const msg = formatRestoreSuccessMessage(content, timestamp)
          const preview = content.slice(0, 50)
          return msg.includes(preview)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any message content longer than 50 chars, only the first 50 chars appear in the message', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 51, maxLength: 500 }),
        isoTimestampArb,
        (content, timestamp) => {
          const msg = formatRestoreSuccessMessage(content, timestamp)
          const first50 = content.slice(0, 50)
          const char51 = content[50]!
          // The first 50 chars are present
          if (!msg.includes(first50)) return false
          // The 51st char is NOT present in the preview portion
          // (it could appear in the timestamp by coincidence, so we check
          // the specific preview section)
          const previewEnd = msg.indexOf(first50) + first50.length
          const afterPreview = msg.slice(previewEnd)
          // afterPreview should start with `"` (closing quote), not the 51st char
          return afterPreview.startsWith('"')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any timestamp, the formatted timestamp appears in the success message', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        isoTimestampArb,
        (content, isoTs) => {
          const msg = formatRestoreSuccessMessage(content, isoTs)
          const formatted = new Date(isoTs).toLocaleString()
          return msg.includes(formatted)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('the success message always starts with "Restored to"', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        isoTimestampArb,
        (content, timestamp) => {
          const msg = formatRestoreSuccessMessage(content, timestamp)
          return msg.startsWith('Restored to "')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('the success message wraps the preview in quotes and the timestamp in parentheses', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        isoTimestampArb,
        (content, timestamp) => {
          const msg = formatRestoreSuccessMessage(content, timestamp)
          const formatted = new Date(timestamp).toLocaleString()
          // Pattern: Restored to "..." (...)
          return (
            msg.includes('"') &&
            msg.includes(`(${formatted})`)
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
