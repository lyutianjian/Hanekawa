import assert from 'node:assert/strict'
import test from 'node:test'
import { createPresence, finishPresenceWithin } from '../src/desktop/renderer/dom/presence.js'
import { PRESENCE_FALLBACK_MS } from '../src/desktop/renderer/model/presence.js'
import { installDomStub } from './helpers/domStub.js'

test('presence reverses without unmounting, scopes end events, and settles hidden work', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = stub.createContainer()
  const node = stub.createContainer('menu')
  const child = stub.createContainer()
  node.appendChild(child)
  root.appendChild(node)
  let closes = 0
  const presence = createPresence(node, { onClosed: () => { closes += 1 } })
  t.after(() => presence.dispose())
  presence.set(true)
  assert.equal(presence.phase, 'entering')
  assert.equal(node.hidden, false)
  presence.set(false)
  assert.equal(presence.phase, 'closing')
  assert.equal(node.getAttribute('aria-hidden'), 'true')
  assert.equal(node.getAttribute('inert'), '')
  stub.dispatch(node, 'transitionend', { propertyName: 'opacity', target: child })
  stub.dispatch(node, 'transitionend', { propertyName: 'color' })
  assert.equal(presence.phase, 'closing')
  presence.set(true)
  t.mock.timers.tick(PRESENCE_FALLBACK_MS.popover)
  assert.equal(presence.phase, 'open')
  assert.equal(node.parentElement, root)
  assert.equal(closes, 0)
  presence.set(false)
  finishPresenceWithin(root)
  assert.equal(presence.phase, 'closed')
  assert.equal(node.hidden, true)
  assert.equal(closes, 1)
  t.mock.timers.tick(PRESENCE_FALLBACK_MS.popover)
  assert.equal(closes, 1, 'the cleared fallback cannot close a second time')
})
