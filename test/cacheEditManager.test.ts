import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheEditManager } from '../src/harness/cacheEditManager.js'

test('registers tool results and produces cache_edits when threshold crossed', () => {
  const manager = new CacheEditManager({ keepRecent: 2, triggerAfter: 3 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(0, 'tr-2', 'Bash', 800)
  manager.registerToolResult(1, 'tr-3', 'Grep', 300)
  manager.registerToolResult(1, 'tr-4', 'Glob', 200)

  const edits = manager.produceCacheEdits()
  assert.ok(edits)
  assert.equal(edits.edits.length, 2) // deletes tr-1 and tr-2
  assert.deepEqual(edits.edits.map(e => e.cache_reference).sort(), ['tr-1', 'tr-2'])
})

test('does not produce edits below trigger threshold', () => {
  const manager = new CacheEditManager({ keepRecent: 2, triggerAfter: 3 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(1, 'tr-2', 'Bash', 800)
  assert.equal(manager.produceCacheEdits(), null)
})

test('consumes pending edits', () => {
  const manager = new CacheEditManager({ keepRecent: 1, triggerAfter: 2 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(1, 'tr-2', 'Bash', 800)
  manager.registerToolResult(2, 'tr-3', 'Grep', 300)

  const edits = manager.produceCacheEdits()
  assert.ok(edits)

  const consumed = manager.consumePendingEdits()
  assert.ok(consumed)
  assert.deepEqual(consumed.edits, edits.edits)

  // Second consume returns null
  assert.equal(manager.consumePendingEdits(), null)
})

test('pins and retrieves edits', () => {
  const manager = new CacheEditManager({ keepRecent: 1, triggerAfter: 2 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(1, 'tr-2', 'Bash', 800)
  manager.registerToolResult(2, 'tr-3', 'Grep', 300)

  const edits = manager.produceCacheEdits()
  assert.ok(edits)
  manager.pinEdits(2, edits)

  const pinned = manager.getPinnedEdits()
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].userMessageIndex, 2)
})

test('deduplicates edits across pinned blocks', () => {
  const manager = new CacheEditManager({ keepRecent: 1, triggerAfter: 2 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(1, 'tr-2', 'Bash', 800)
  manager.registerToolResult(2, 'tr-3', 'Grep', 300)

  const edits1 = manager.produceCacheEdits()
  assert.ok(edits1)
  manager.pinEdits(0, edits1)

  manager.registerToolResult(3, 'tr-4', 'Glob', 200)
  const edits2 = manager.produceCacheEdits()
  if (edits2) manager.pinEdits(1, edits2)

  const pinned = manager.getPinnedEdits()
  const allRefs = pinned.flatMap(p => p.block.edits.map(e => e.cache_reference))
  assert.equal(allRefs.length, new Set(allRefs).size, 'no duplicates')
})

test('reset clears all state', () => {
  const manager = new CacheEditManager({ keepRecent: 1, triggerAfter: 2 })
  manager.registerToolResult(0, 'tr-1', 'Read', 500)
  manager.registerToolResult(1, 'tr-2', 'Bash', 800)
  manager.produceCacheEdits()
  manager.pinEdits(0, { type: 'cache_edits', edits: [{ type: 'delete', cache_reference: 'tr-1' }] })

  manager.reset()
  assert.deepEqual(manager.getPinnedEdits(), [])
  assert.equal(manager.consumePendingEdits(), null)
  assert.equal(manager.getRegisteredToolUseIds().size, 0)
})
