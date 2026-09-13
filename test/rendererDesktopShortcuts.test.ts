import assert from 'node:assert/strict'
import test from 'node:test'
import {
  desktopShortcut,
  isMacSessionCloseShortcut,
  type DesktopShortcut,
} from '../src/desktop/renderer/model/desktopShortcuts.js'
import type { KeyChord } from '../src/desktop/renderer/model/keymap.js'

test('desktop shortcut labels use the host platform, including Shift and punctuation', () => {
  const labels: [DesktopShortcut, string, string][] = [
    ['toggle-sidebar', '⌘B', 'Ctrl+B'],
    ['new-session', '⌘T', 'Ctrl+T'],
    ['close-session', '⌘W', 'Ctrl+W'],
    ['switch-session', '⌘1-9', 'Ctrl+1-9'],
    ['open-project', '⇧⌘O', 'Ctrl+Shift+O'],
    ['open-settings', '⌘,', 'Ctrl+,'],
  ]
  for (const [action, mac, other] of labels) {
    assert.equal(desktopShortcut('darwin', action), mac)
    assert.equal(desktopShortcut('win32', action), other)
    assert.equal(desktopShortcut('linux', action), other)
  }
})

test('only plain Command+W bypasses the native Close Window accelerator', () => {
  assert.equal(isMacSessionCloseShortcut({ key: 'w', metaKey: true }), true)
  assert.equal(isMacSessionCloseShortcut({ key: 'W', metaKey: true }), true)

  const nativeOrUnmodified: KeyChord[] = [
    { key: 'w' },
    { key: 'w', ctrlKey: true },
    { key: 'w', metaKey: true, shiftKey: true },
    { key: 'w', metaKey: true, altKey: true },
    { key: 'w', metaKey: true, ctrlKey: true },
    { key: 'q', metaKey: true },
    { key: 'c', metaKey: true },
    { key: 'v', metaKey: true },
    { key: 'f', metaKey: true, ctrlKey: true },
    { key: 'Meta', metaKey: true },
  ]
  for (const chord of nativeOrUnmodified) assert.equal(isMacSessionCloseShortcut(chord), false)
})
