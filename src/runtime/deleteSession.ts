import { rm } from 'node:fs/promises'
import { getSubagentTranscriptDir } from '../harness/sidechainRecordStream.js'
import { removeShadowRepo } from '../services/checkpoint/checkpointService.js'
import { clearSessionMemory } from '../services/sessionMemory/service.js'
import { assertSafeSessionId, type SessionMeta } from '../sessions/service.js'

/**
 * Everything one session leaves on disk, deleted in one place.
 *
 * This exists because "delete a session" had no owner. `SessionStore.delete`
 * removes three files and an index entry — which is all it can, since the other
 * artifacts belong to modules that sit *above* `sessions/` in the layering and
 * calling back down would be a cycle. So the composition has to live somewhere,
 * and until this module it lived in the Electron shell: `ShellHost.deleteSession`
 * called the store and then `removeShadowRepo`, which left two more directories
 * behind, and any second deletion path (a `/delete` command, a TUI list, a
 * cleanup job) would have started from zero and leaked all three.
 *
 * `runtime/` is the layer that already depends on both `harness/` and
 * `services/`, so it is the only place the full list can be named.
 *
 * **Adding an artifact goes here.** If a feature starts writing
 * `.myagent/<something>/<sessionId>`, this function is what makes it removable.
 */

/** The slice of `SessionStore` this needs. Structural so a test fakes it without casting. */
export interface SessionArtifactStore {
  delete(idOrPrefix: string): Promise<void>
}

/**
 * Deletes every artifact of one session.
 *
 * `sessionId` must be the id the store **resolved**, not a prefix: `store.delete`
 * accepts a prefix but every path below turns the string into a directory or
 * filename, so a prefix would delete the right index entry and miss (or worse,
 * mis-target) the rest. The guard is the store's own, and it rejects `''`, `'.'`,
 * `'..'` and anything carrying a separator — two of the removals below are
 * `recursive`, and `path.join(dir, '')` is `dir`.
 *
 * Best-effort per artifact and sequential: the store goes first because its index
 * entry is what makes the session *visible*, so a failure later leaves an
 * orphaned directory rather than a row pointing at a half-deleted session.
 */
export async function deleteSessionArtifacts(
  cwd: string,
  store: SessionArtifactStore,
  sessionId: string,
): Promise<void> {
  assertSafeSessionId(sessionId)
  await store.delete(sessionId)
  await removeShadowRepo(cwd, sessionId)
  await clearSessionMemory(sessionId, cwd)
  await removeSubagentTranscripts(cwd, sessionId)
}

/**
 * The session's subagent transcripts — one file per background agent it ran.
 *
 * Separate export because `/agents cleanup` removes subagent git worktrees and
 * not these, so a future caller may want one without the other.
 */
export async function removeSubagentTranscripts(cwd: string, sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId)
  await rm(getSubagentTranscriptDir(cwd, sessionId), { recursive: true, force: true })
}

/** Re-exported so a caller resolving before deleting has the type to hand. */
export type { SessionMeta }
