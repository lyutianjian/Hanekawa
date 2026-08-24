import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  followsSystem,
  parseThemePreference,
  resolveTheme,
  systemThemeFromMatches,
} from '../src/desktop/renderer/model/theme.js'

test('the constants are the agreed values', () => {
  assert.equal(THEME_STORAGE_KEY, 'ui-theme')
  assert.equal(DEFAULT_THEME_PREFERENCE, 'system')
  assert.deepEqual([...THEME_PREFERENCES], ['system', 'dark', 'light'])
})

test('parseThemePreference passes the three known values and defaults everything else', () => {
  assert.equal(parseThemePreference('system'), 'system')
  assert.equal(parseThemePreference('dark'), 'dark')
  assert.equal(parseThemePreference('light'), 'light')

  // Junk, empty, case, null and undefined all fall to the default rather than
  // leaving `dataset.theme` unset or wrong.
  assert.equal(parseThemePreference(null), 'system')
  assert.equal(parseThemePreference(undefined), 'system')
  assert.equal(parseThemePreference(''), 'system')
  assert.equal(parseThemePreference('garbage'), 'system')
  assert.equal(parseThemePreference('Dark'), 'system')
})

test('resolveTheme defers to the system only for the system preference', () => {
  assert.equal(resolveTheme('system', 'dark'), 'dark')
  assert.equal(resolveTheme('system', 'light'), 'light')
  // An explicit choice ignores the system entirely.
  assert.equal(resolveTheme('dark', 'light'), 'dark')
  assert.equal(resolveTheme('light', 'dark'), 'light')
})

test('followsSystem is true only for system', () => {
  assert.equal(followsSystem('system'), true)
  assert.equal(followsSystem('dark'), false)
  assert.equal(followsSystem('light'), false)
})

test('systemThemeFromMatches maps the prefers-color-scheme boolean', () => {
  assert.equal(systemThemeFromMatches(true), 'dark')
  assert.equal(systemThemeFromMatches(false), 'light')
})
