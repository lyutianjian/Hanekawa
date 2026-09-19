/**
 * Where a snapshot lives between the call that took it and the calls that page
 * through it.
 *
 * The cache exists because a snapshot is *one* reading of *one* document. Paging
 * must not re-scan: the page would have moved, and the second half of the answer
 * would belong to a different DOM than the first. So the whole rendering is kept
 * here and cursors index into it.
 *
 * Three things identify an entry, and all three are checked on every read:
 * the tab, the renderer process that produced it, and the navigation generation.
 * A mismatch on any of them means the answer is about a document that no longer
 * exists. So does an id nobody issued, and so does a malformed cursor — all
 * three come back as `SNAPSHOT_EXPIRED` with the same message. A caller that
 * could tell "wrong owner" from "no such snapshot" apart would have a probe for
 * what other tabs exist; the caller that merely paged too late loses nothing by
 * being told to take a new snapshot.
 *
 * Eviction is FIFO. Snapshots are read once, front to back, within seconds of
 * being taken; LRU's notion of heat has nothing to measure here.
 */

import { randomUUID } from 'node:crypto'

import { BrowserHostError } from './errors.js'
import { SNAPSHOT_CACHE_MAX_BYTES, SNAPSHOT_CACHE_MAX_ENTRIES, SNAPSHOT_CACHE_TTL_MS } from './limits.js'

export interface SnapshotOwner {
  tabId: string
  contentsId: number
  generation: number
}

export interface Snapshot {
  kind: 'elements' | 'text'
  header: string
  lines: string[]
}

export function ownerKey(owner: SnapshotOwner): string {
  return `${owner.tabId}:${owner.contentsId}:${owner.generation}`
}

const CURSOR_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,9})$/

const EXPIRED_MESSAGE =
  'That snapshot is no longer available — the page has changed or the snapshot aged out. Take a new snapshot.'

function expired(): BrowserHostError {
  return new BrowserHostError('SNAPSHOT_EXPIRED', EXPIRED_MESSAGE)
}

interface Entry {
  owner: string
  snapshot: Snapshot
  bytes: number
  createdAt: number
}

export class SnapshotCache {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly ttlMs: number
  private bytes = 0

  constructor(options: { now?: () => number; maxBytes?: number; maxEntries?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes ?? SNAPSHOT_CACHE_MAX_BYTES
    this.maxEntries = options.maxEntries ?? SNAPSHOT_CACHE_MAX_ENTRIES
    this.ttlMs = options.ttlMs ?? SNAPSHOT_CACHE_TTL_MS
  }

  /** Stores a snapshot and returns its id. The id is half of every cursor. */
  put(owner: SnapshotOwner, snapshot: Snapshot): string {
    const id = randomUUID()
    let bytes = snapshot.header.length
    for (const line of snapshot.lines) bytes += line.length + 1
    this.entries.set(id, { owner: ownerKey(owner), snapshot, bytes, createdAt: this.now() })
    this.bytes += bytes
    this.evict()
    return id
  }

  /**
   * Resolves a cursor against its owner.
   *
   * Validation order does not matter — every failure has the same answer — but
   * the shape check comes first so a caller cannot use timing to learn whether
   * an id it made up happens to exist.
   */
  read(owner: SnapshotOwner, cursor: string): { snapshotId: string; snapshot: Snapshot; offset: number } {
    const match = CURSOR_PATTERN.exec(cursor)
    if (match === null) throw expired()
    const [, id = '', offsetText = ''] = match
    const entry = this.entries.get(id)
    if (entry === undefined) throw expired()
    if (entry.owner !== ownerKey(owner)) throw expired()
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.drop(id)
      throw expired()
    }
    const offset = Number(offsetText)
    if (offset > entry.snapshot.lines.length) throw expired()
    return { snapshotId: id, snapshot: entry.snapshot, offset }
  }

  /** Everything a closing tab left behind. */
  dropTab(tabId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.owner.startsWith(`${tabId}:`)) this.drop(id)
    }
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  /** For tests and the debug entry: how much is held right now. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes }
  }

  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    this.bytes -= entry.bytes
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, entry] of [...this.entries]) {
      if (entry.createdAt < cutoff) this.drop(id)
    }
    // `Map` iterates in insertion order, so the first key is the oldest — which
    // is the whole implementation of FIFO.
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.drop(oldest.value)
    }
  }
}
