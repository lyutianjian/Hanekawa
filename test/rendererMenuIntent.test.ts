import assert from 'node:assert/strict'
import test from 'node:test'
import { MENU_INTENT_DELAY_MS, submenuIntentDelay } from '../src/desktop/renderer/model/menuIntent.js'

test('diagonal movement toward the open flyout gets a small grace period, movement away is immediate', () => {
  const left = { left: 0, right: 200, top: 0, bottom: 240 }
  assert.equal(submenuIntentDelay({ x: 300, y: 80 }, { x: 270, y: 100 }, left), MENU_INTENT_DELAY_MS)
  assert.equal(submenuIntentDelay({ x: 300, y: 80 }, { x: 320, y: 100 }, left), 0)
  assert.equal(submenuIntentDelay({ x: 300, y: 80 }, { x: 290, y: 220 }, left), 0)
  assert.equal(submenuIntentDelay(undefined, { x: 270, y: 100 }, left), 0)
  const right = { left: 400, right: 600, top: 0, bottom: 240 }
  assert.equal(submenuIntentDelay({ x: 300, y: 80 }, { x: 330, y: 100 }, right), MENU_INTENT_DELAY_MS)
})
