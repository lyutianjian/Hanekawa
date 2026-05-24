import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERMISSION_OPTIONS,
  nextPermissionIndex,
  resolvePermissionAction,
} from '../src/tui/components/PermissionDialog.js'

/**
 * Unit tests for the pure logic backing the PermissionDialog component.
 *
 * Following the project convention (see `restoreMode.test.ts`) we do not render
 * Ink components in tests. Instead, the dialog's interaction logic is exposed
 * as pure functions and exercised here.
 */

describe('PERMISSION_OPTIONS', () => {
  it('has exactly three options', () => {
    assert.equal(PERMISSION_OPTIONS.length, 3)
  })

  it('exposes allow / deny / always actions in order', () => {
    assert.deepEqual(
      PERMISSION_OPTIONS.map((o) => o.action),
      ['allow', 'deny', 'always'],
    )
  })

  it('uses unique hotkeys', () => {
    const hotkeys = PERMISSION_OPTIONS.map((o) => o.hotkey)
    assert.equal(new Set(hotkeys).size, hotkeys.length)
  })

  it('binds the conventional y/n/a hotkeys', () => {
    assert.deepEqual(
      PERMISSION_OPTIONS.map((o) => o.hotkey),
      ['y', 'n', 'a'],
    )
  })

  it('provides non-empty human-readable labels', () => {
    for (const option of PERMISSION_OPTIONS) {
      assert.ok(option.label.length > 0, `expected label for ${option.action}`)
    }
  })
})

describe('nextPermissionIndex', () => {
  it('moves up by one when above zero', () => {
    assert.equal(nextPermissionIndex(1, 'up', 3), 0)
    assert.equal(nextPermissionIndex(2, 'up', 3), 1)
  })

  it('clamps at zero when moving up from the top', () => {
    assert.equal(nextPermissionIndex(0, 'up', 3), 0)
  })

  it('moves down by one when below the last index', () => {
    assert.equal(nextPermissionIndex(0, 'down', 3), 1)
    assert.equal(nextPermissionIndex(1, 'down', 3), 2)
  })

  it('clamps at total - 1 when moving down from the bottom', () => {
    assert.equal(nextPermissionIndex(2, 'down', 3), 2)
  })

  it('clamps a negative current to zero before applying direction', () => {
    // -1 -> clamp to 0, then down -> 1
    assert.equal(nextPermissionIndex(-1, 'down', 3), 1)
    // -1 -> clamp to 0, then up -> still 0
    assert.equal(nextPermissionIndex(-1, 'up', 3), 0)
  })

  it('clamps an oversized current to total - 1 before applying direction', () => {
    // 99 -> clamp to 2, then up -> 1
    assert.equal(nextPermissionIndex(99, 'up', 3), 1)
    // 99 -> clamp to 2, then down -> still 2
    assert.equal(nextPermissionIndex(99, 'down', 3), 2)
  })

  it('returns 0 when total is non-positive', () => {
    assert.equal(nextPermissionIndex(5, 'up', 0), 0)
    assert.equal(nextPermissionIndex(5, 'down', -1), 0)
  })
})

describe('resolvePermissionAction', () => {
  it('maps index 0 to allow', () => {
    assert.equal(resolvePermissionAction(0), 'allow')
  })

  it('maps index 1 to deny', () => {
    assert.equal(resolvePermissionAction(1), 'deny')
  })

  it('maps index 2 to always', () => {
    assert.equal(resolvePermissionAction(2), 'always')
  })

  it('clamps negative indices to the first action', () => {
    assert.equal(resolvePermissionAction(-1), 'allow')
    assert.equal(resolvePermissionAction(-100), 'allow')
  })

  it('clamps oversized indices to the last action', () => {
    assert.equal(resolvePermissionAction(3), 'always')
    assert.equal(resolvePermissionAction(99), 'always')
  })

  it('agrees with PERMISSION_OPTIONS for every valid index', () => {
    for (let i = 0; i < PERMISSION_OPTIONS.length; i++) {
      assert.equal(resolvePermissionAction(i), PERMISSION_OPTIONS[i]!.action)
    }
  })
})
