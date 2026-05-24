import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import fc from 'fast-check'
import { SessionStore } from '../src/sessions/service.js'

/**
 * Feature: keyboard-shortcuts-control, Property 7: Checkpoint reference round-trip
 *
 * Validates: Requirements 5.3
 *
 * For any successfully created checkpoint with a given (messageId, commitHash) pair,
 * querying the session metadata for checkpoint mappings SHALL return an entry
 * containing that exact pair.
 *
 * The round-trip is exercised through the persistence layer (SessionStore):
 *   - addCheckpointMapping(sessionId, messageId, commitHash) stores a mapping
 *     in the session JSON metadata file (`.myagent/sessions/<id>.json`).
 *   - getCheckpointMappings(sessionId) reads the same file and returns the
 *     stored mappings.
 *
 * Generators:
 *   - messageId: fc.uuid() — arbitrary RFC-4122 UUIDs, matching how user
 *     message IDs are produced elsewhere in the codebase (`randomUUID()`).
 *   - commitHash: hex strings of varying length [4, 64] — covers both
 *     short hashes, full SHA-1 (40 chars), and SHA-256 (64 chars). Note
 *     that SessionStore does not validate hash format; it stores whatever
 *     string is supplied. The generator stays within the realistic shape
 *     so the test reflects real-world usage.
 *
 * Each property iteration uses its own temp `cwd` (`mkdtemp`) and a fresh
 * session, so iterations cannot interfere with each other.
 */

async function makeTempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'myagent-checkpoint-prop-'))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Hex string of length [4, 64] — covers short hashes through SHA-256.
 *
 * `fc.hexaString` produces strings drawn from the hex alphabet `[0-9a-f]`.
 * Note that SessionStore does not validate hash format; it stores whatever
 * string is supplied. The generator stays within a realistic shape so the
 * test reflects real-world usage of the API.
 */
const commitHashArb = fc.hexaString({ minLength: 4, maxLength: 64 })

/**
 * A non-empty list of (messageId, commitHash) pairs with unique messageIds.
 * Uniqueness on messageId reflects real usage: each user message has its own
 * UUID, and `addCheckpointMapping` is called once per message. It also makes
 * the round-trip assertion unambiguous (no duplicate keys to disambiguate).
 */
const mappingsArb = fc
  .uniqueArray(
    fc.record({
      messageId: fc.uuid(),
      commitHash: commitHashArb,
    }),
    {
      minLength: 1,
      maxLength: 10,
      selector: (entry) => entry.messageId,
    },
  )

describe('CheckpointService round-trip — Property 7: checkpoint reference round-trip', () => {
  it('every (messageId, commitHash) pair added via addCheckpointMapping is returned by getCheckpointMappings', async () => {
    await fc.assert(
      fc.asyncProperty(mappingsArb, async (mappings) => {
        const cwd = await makeTempCwd()
        try {
          const store = new SessionStore(cwd)
          await store.init()
          const session = await store.create('checkpoint round-trip')

          // Sanity: a freshly created session has no checkpoints.
          const initial = await store.getCheckpointMappings(session.id)
          assert.deepEqual(initial, [], 'fresh session should have no checkpoint mappings')

          // Round-trip: add each mapping, then query and verify every pair is present.
          for (const m of mappings) {
            await store.addCheckpointMapping(session.id, m.messageId, m.commitHash)
          }

          const retrieved = await store.getCheckpointMappings(session.id)

          // The stored set SHALL contain exactly the input pairs.
          assert.equal(
            retrieved.length,
            mappings.length,
            `expected ${mappings.length} mappings, got ${retrieved.length}`,
          )

          // For every input pair, the retrieved list must contain an entry with
          // that exact messageId AND that exact commitHash.
          for (const expected of mappings) {
            const found = retrieved.find((r) => r.messageId === expected.messageId)
            assert.ok(
              found,
              `messageId ${expected.messageId} not found in retrieved mappings`,
            )
            assert.equal(
              found!.commitHash,
              expected.commitHash,
              `commitHash mismatch for ${expected.messageId}: expected ${expected.commitHash}, got ${found!.commitHash}`,
            )
            // The persisted entry must also carry a parseable createdAt timestamp,
            // which is the third field of the CheckpointMapping interface.
            assert.ok(
              found!.createdAt && !Number.isNaN(Date.parse(found!.createdAt)),
              `createdAt is not a valid ISO date: ${found!.createdAt}`,
            )
          }
        } finally {
          await cleanup(cwd)
        }
      }),
      { numRuns: 100 },
    )
  })
})
