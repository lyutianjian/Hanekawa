import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_WIDTH_DEFAULT,
  BROWSER_WIDTH_MAX,
  BROWSER_WIDTH_MIN,
  addressLabel,
  browserWidthVariable,
  clampBrowserWidth,
  normalizeAddress,
  parseBrowserWidth,
  resolveActiveTab,
  shouldShowBrowserView,
  tabLabel,
  tabsForLane,
} from '../src/desktop/renderer/model/browserPanel.js'
import type { WireBrowserTabInfo } from '../src/desktop/shellProtocol.js'

/**
 * The browser panel's decisions, without a window.
 *
 * Everything the panel has to get right that is *not* compositing — which lane's
 * tabs are on screen, which one survives a close, when the native view may
 * paint, and what a typed address means — is arithmetic over data and is tested
 * here. The `WebContentsView` actually covering its hole is the smoke's job.
 */

function tab(overrides: Partial<WireBrowserTabInfo> & { tabId: string; lane: string }): WireBrowserTabInfo {
  return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, ...overrides }
}

// --- width ---------------------------------------------------------------------

test('a panel width is clamped to its bounds and rounded', () => {
  assert.equal(clampBrowserWidth(BROWSER_WIDTH_MIN - 200), BROWSER_WIDTH_MIN)
  assert.equal(clampBrowserWidth(BROWSER_WIDTH_MAX + 200), BROWSER_WIDTH_MAX)
  assert.equal(clampBrowserWidth(512.6), 513)
})

test('a width that is not a number falls back to the default, not to the minimum', () => {
  // `NaN` means "no width at all", which is a different question from "a width
  // below the floor" — answering it with the floor would silently shrink the
  // panel for anyone whose stored value went bad.
  assert.equal(clampBrowserWidth(Number.NaN), BROWSER_WIDTH_DEFAULT)
  assert.equal(parseBrowserWidth(null), BROWSER_WIDTH_DEFAULT)
  assert.equal(parseBrowserWidth('not a width'), BROWSER_WIDTH_DEFAULT)
})

test('a stored width from an older build is clamped rather than discarded', () => {
  assert.equal(parseBrowserWidth(String(BROWSER_WIDTH_MAX + 500)), BROWSER_WIDTH_MAX)
  assert.equal(browserWidthVariable(BROWSER_WIDTH_DEFAULT), `${BROWSER_WIDTH_DEFAULT}px`)
})

// --- which tabs ------------------------------------------------------------------

test('a lane sees only its own tabs, and no lane sees none', () => {
  const tabs = [tab({ tabId: 'a', lane: '1' }), tab({ tabId: 'b', lane: '2' }), tab({ tabId: 'c', lane: '1' })]
  assert.deepEqual(tabsForLane(tabs, '1').map((t) => t.tabId), ['a', 'c'])
  // Before the first `activate` there is no active pane. Answering with every
  // lane's tabs would draw another session's browser.
  assert.deepEqual(tabsForLane(tabs, undefined), [])
})

test('the preferred tab wins while it exists, and its neighbour inherits when it closes', () => {
  const tabs = [tab({ tabId: 'a', lane: '1' }), tab({ tabId: 'b', lane: '1' })]
  assert.equal(resolveActiveTab(tabs, '1', 'a'), 'a')
  // 'a' was closed: the fallback is the last remaining tab, so closing the
  // active tab lands on a neighbour rather than on an empty panel.
  assert.equal(resolveActiveTab([tabs[1]!], '1', 'a'), 'b')
  assert.equal(resolveActiveTab(tabs, '1', undefined), 'b')
  assert.equal(resolveActiveTab(tabs, '2', undefined), undefined)
})

// --- visibility --------------------------------------------------------------------

test('the native view paints only when all four conditions hold', () => {
  const base = { open: true, hasActiveTab: true, occluded: false, windowHidden: false }
  assert.equal(shouldShowBrowserView(base), true)
  assert.equal(shouldShowBrowserView({ ...base, open: false }), false)
  assert.equal(shouldShowBrowserView({ ...base, hasActiveTab: false }), false)
  // The last two are the ones a DOM-only panel would forget: a WebContentsView
  // is not in the document, so neither a covering screen nor a hidden window
  // stops it painting on its own.
  assert.equal(shouldShowBrowserView({ ...base, occluded: true }), false)
  assert.equal(shouldShowBrowserView({ ...base, windowHidden: true }), false)
})

// --- the address bar ------------------------------------------------------------------

test('a bare host gets https, and a full URL is preserved', () => {
  assert.equal(normalizeAddress('example.com'), 'https://example.com/')
  assert.equal(normalizeAddress('  example.com/a?b=1 '), 'https://example.com/a?b=1')
  assert.equal(normalizeAddress('http://example.com/x'), 'http://example.com/x')
})

test('anything but http and https is not an address', () => {
  // `file:` by name: this partition is the agent's browsing context, and a
  // file:// document there reads the user's disk with a page's privileges.
  assert.equal(normalizeAddress('file:///etc/passwd'), undefined)
  assert.equal(normalizeAddress('javascript:alert(1)'), undefined)
  assert.equal(normalizeAddress('data:text/html,<b>x'), undefined)
  assert.equal(normalizeAddress(''), undefined)
  assert.equal(normalizeAddress('   '), undefined)
})

test('a typo stays a typo — there is no search fallback', () => {
  // Falling back to a search engine would ship whatever the user typed, which
  // may be a path or a password, to a third party on a slip of the keyboard.
  assert.equal(normalizeAddress('https://'), undefined)
})

// --- labels -----------------------------------------------------------------------------

test('a tab reads as its title, then its host, then a placeholder', () => {
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1', title: '示例', url: 'https://example.com/x' })), '示例')
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1', url: 'https://example.com/x' })), 'example.com')
  assert.equal(tabLabel(tab({ tabId: 'a', lane: '1' })), '新标签页')
})

test('the address bar shows a host, and shows nothing for a tab that never navigated', () => {
  assert.equal(addressLabel(tab({ tabId: 'a', lane: '1', url: 'https://example.com/deep/path' })), 'example.com')
  assert.equal(addressLabel(tab({ tabId: 'a', lane: '1' })), '')
  assert.equal(addressLabel(undefined), '')
})
