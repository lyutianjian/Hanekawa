import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { SnapshotCache, ownerKey, type SnapshotOwner } from '../src/desktop/browser/snapshotCache.js'

/**
 * The cache's one job is refusing to answer about a document that has moved.
 *
 * Every refusal below has to be the *same* refusal: a caller that could tell an
 * unknown id from a wrong owner from a malformed cursor would have a probe for
 * what other tabs exist.
 */

const owner: SnapshotOwner = { tabId: 'tab-1', contentsId: 7, generation: 3 }

function cache(now: () => number = Date.now, options: { maxEntries?: number; ttlMs?: number; maxBytes?: number } = {}) {
  return new SnapshotCache({ now, ...options })
}

function snapshot(lines: string[] = ['a', 'b', 'c']) {
  return { kind: 'elements' as const, header: '# head', lines }
}

function expired(error: unknown): boolean {
  return error instanceof BrowserHostError && error.code === 'SNAPSHOT_EXPIRED'
}

test('a cursor resolves against the owner that issued it', () => {
  const store = cache()
  const id = store.put(owner, snapshot())
  const read = store.read(owner, `${id}:2`)
  assert.equal(read.offset, 2)
  assert.deepEqual(read.snapshot.lines, ['a', 'b', 'c'])
})

test('every way of being wrong gives the same answer', () => {
  const store = cache()
  const id = store.put(owner, snapshot())
  const message = (fn: () => unknown): string => {
    try {
      fn()
    } catch (error) {
      assert.ok(expired(error))
      return (error as Error).message
    }
    throw new Error('expected a refusal')
  }

  const wrongGeneration = message(() => store.read({ ...owner, generation: 4 }, `${id}:0`))
  const wrongContents = message(() => store.read({ ...owner, contentsId: 8 }, `${id}:0`))
  const wrongTab = message(() => store.read({ ...owner, tabId: 'tab-2' }, `${id}:0`))
  const unknownId = message(() => store.read(owner, '00000000-0000-0000-0000-000000000000:0'))
  const malformed = message(() => store.read(owner, 'not-a-cursor'))
  const pastTheEnd = message(() => store.read(owner, `${id}:9`))

  assert.equal(new Set([wrongGeneration, wrongContents, wrongTab, unknownId, malformed, pastTheEnd]).size, 1)
})

test('an entry ages out', () => {
  let clock = 1000
  const store = cache(() => clock, { ttlMs: 500 })
  const id = store.put(owner, snapshot())
  clock += 501
  assert.throws(() => store.read(owner, `${id}:0`), expired)
  assert.equal(store.stats().entries, 0)
})

test('eviction is FIFO: the oldest entry goes first', () => {
  const store = cache(Date.now, { maxEntries: 2 })
  const first = store.put(owner, snapshot())
  const second = store.put(owner, snapshot())
  const third = store.put(owner, snapshot())
  assert.throws(() => store.read(owner, `${first}:0`), expired)
  assert.equal(store.read(owner, `${second}:0`).offset, 0)
  assert.equal(store.read(owner, `${third}:0`).offset, 0)
})

test('the byte budget evicts too, and the accounting comes back down', () => {
  const store = cache(Date.now, { maxBytes: 64 })
  store.put(owner, snapshot([...'x'.repeat(40)].map((c) => c)))
  store.put(owner, snapshot(['y'.repeat(20)]))
  assert.ok(store.stats().bytes <= 64)
  assert.ok(store.stats().entries >= 1)
})

test('a closing tab takes its snapshots with it', () => {
  const store = cache()
  const mine = store.put(owner, snapshot())
  const other = store.put({ ...owner, tabId: 'tab-2' }, snapshot())
  store.dropTab('tab-1')
  assert.throws(() => store.read(owner, `${mine}:0`), expired)
  assert.equal(store.read({ ...owner, tabId: 'tab-2' }, `${other}:0`).offset, 0)
})

test('the owner key is the whole triple', () => {
  assert.equal(ownerKey(owner), 'tab-1:7:3')
})
