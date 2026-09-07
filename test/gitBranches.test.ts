import assert from 'node:assert/strict'
import test from 'node:test'

import { isSafeBranchName } from '../src/runtime/gitBranches.js'

/**
 * The guard between the wire and `execFile`.
 *
 * argv already keeps a branch name from becoming a second command — nothing here
 * ever goes through a shell — so what is left is the one thing argv cannot stop:
 * a name in the branch slot that git reads as a *flag*. Everything else rejected
 * here is rejected because a legal branch name cannot contain it.
 */

test('a leading dash is refused: argv stops commands, not flags', () => {
  assert.equal(isSafeBranchName('--force'), false)
  assert.equal(isSafeBranchName('-C'), false)
  // Not a blanket ban on the character — plenty of branches carry one.
  assert.equal(isSafeBranchName('fix-the-thing'), true)
})

test('ordinary names, including the ones with slashes and dots, are allowed', () => {
  for (const name of ['master', 'main', 'feature/branch-popover', 'v1.2.x', 'release_2026']) {
    assert.equal(isSafeBranchName(name), true, name)
  }
})

test("git's own reserved characters are refused", () => {
  for (const name of ['a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a..b', 'a.lock', 'a/']) {
    assert.equal(isSafeBranchName(name), false, name)
  }
})

test('control characters and the empty name are refused', () => {
  assert.equal(isSafeBranchName(''), false)
  assert.equal(isSafeBranchName(`a${String.fromCharCode(0)}b`), false)
  assert.equal(isSafeBranchName(`a${String.fromCharCode(0x7f)}b`), false)
  assert.equal(isSafeBranchName('x'.repeat(256)), false)
})
