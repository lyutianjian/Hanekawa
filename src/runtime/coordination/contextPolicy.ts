// Pure policy for when a coordinator's context is worth compacting while idle.
// No I/O: the caller supplies timing and occupancy.

import type { SessionRecord } from '../../harness/types.js'

/** Idle compaction only fires once the window is at least this full. */
export const IDLE_COMPACT_MIN_OCCUPANCY = 0.4

export interface IdleCompactInput {
  idleMs: number
  cacheTtlMs: number
  occupiedTokens?: number
  usableContextWindow: number
}

/**
 * True when the prompt cache has expired while the session sat idle and the
 * context is occupied enough that a compaction pays for itself. Unknown
 * occupancy never qualifies.
 */
export function shouldIdleCompact(input: IdleCompactInput): boolean {
  if (input.idleMs <= input.cacheTtlMs) return false
  if (input.occupiedTokens === undefined) return false
  if (!(input.usableContextWindow > 0)) return false
  return input.occupiedTokens / input.usableContextWindow > IDLE_COMPACT_MIN_OCCUPANCY
}

/** Summary of the most recent compact_boundary record, or undefined when none exists. */
export function lastCompactSummary(records: readonly SessionRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.type === 'compact_boundary') return record.summary
  }
  return undefined
}
