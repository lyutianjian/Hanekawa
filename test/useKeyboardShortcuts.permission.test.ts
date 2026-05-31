import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  isPermissionModeCycleKey,
  permissionModeCycleDirection,
  shouldIgnoreShortcutInput,
} from '../src/tui/hooks/useKeyboardShortcuts.js'

/**
 * Regression tests for the input-leakage fix.
 *
 * Before this change the global TUI shortcut handler kept listening while the
 * permission dialog was visible, so keys like `y`, `n`, `a` were both routed
 * to the dialog AND inserted into the input box's text state. The fix is to
 * disable the handler whenever a modal overlay (permission dialog or restore
 * mode) is on screen.
 *
 * These tests pin the gating logic so it cannot regress silently. The hook
 * itself is React-bound and the project convention is to test pure helpers
 * directly rather than render via ink-testing-library.
 */

describe('shouldIgnoreShortcutInput', () => {
  it('returns false when no overlay is active (input box owns the keyboard)', () => {
    assert.equal(
      shouldIgnoreShortcutInput({ isPermissionVisible: false, isRestoreMode: false }),
      false,
    )
  })

  it('returns true when the permission dialog is visible', () => {
    assert.equal(
      shouldIgnoreShortcutInput({ isPermissionVisible: true, isRestoreMode: false }),
      true,
    )
  })

  it('returns true when restore mode is active', () => {
    assert.equal(
      shouldIgnoreShortcutInput({ isPermissionVisible: false, isRestoreMode: true }),
      true,
    )
  })

  it('returns true when both overlays are simultaneously flagged', () => {
    // Defensive: in practice these don't overlap, but the gate must still
    // suppress keystrokes if they ever do.
    assert.equal(
      shouldIgnoreShortcutInput({ isPermissionVisible: true, isRestoreMode: true }),
      true,
    )
  })
})

describe('isPermissionModeCycleKey', () => {
  it('returns true for Shift+Tab', () => {
    assert.equal(
      isPermissionModeCycleKey({ tab: true, shift: true } as never),
      true,
    )
  })

  it('returns false for plain Tab', () => {
    assert.equal(
      isPermissionModeCycleKey({ tab: true, shift: false } as never),
      false,
    )
  })
})

describe('permissionModeCycleDirection', () => {
  it('uses Shift+Tab for forward mode cycling', () => {
    assert.equal(permissionModeCycleDirection({ tab: true, shift: true } as never), 1)
  })

  it('does not expose a reverse cycle shortcut', () => {
    assert.equal(permissionModeCycleDirection({ tab: true, shift: false } as never), 1)
  })
})
