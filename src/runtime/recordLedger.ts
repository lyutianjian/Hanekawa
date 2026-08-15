import type { SessionRecord } from '../harness/types.js'

/**
 * The live record list for a session, deduped by id.
 *
 * Records reach a host over several paths — the record bridge, a wholesale
 * transcript reset after a rewind, the initial load — and the same record can
 * arrive twice. Whoever rebuilds a runtime needs the complete list, because
 * `createRuntime` folds records into the tool context's task state: a model
 * switch that passes a stale list silently loses everything appended since
 * startup.
 *
 * This is the framework-agnostic half of what `App.tsx` keeps in
 * `sessionRecordsRef`; the TUI still owns its own copy.
 */
export class SessionRecordLedger {
  private records: SessionRecord[]
  private ids: Set<string>

  constructor(initial: readonly SessionRecord[] = []) {
    this.records = [...initial]
    this.ids = new Set(this.records.map((record) => record.id))
  }

  /** Appends unless already present. Returns whether it was new. */
  track(record: SessionRecord): boolean {
    if (this.ids.has(record.id)) return false
    this.ids.add(record.id)
    this.records.push(record)
    return true
  }

  /** Replaces the list wholesale, after the session's records changed on disk. */
  rebase(records: readonly SessionRecord[]): void {
    this.records = [...records]
    this.ids = new Set(this.records.map((record) => record.id))
  }

  list(): readonly SessionRecord[] {
    return this.records
  }

  get size(): number {
    return this.records.length
  }
}
