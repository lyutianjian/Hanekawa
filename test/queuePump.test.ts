import test from 'node:test'
import assert from 'node:assert/strict'
import { canPumpQueue, type QueuePumpState } from '../src/runtime/queuePump.js'

const ready: QueuePumpState = { pending: 1, running: false, turnActive: false, uiBlocked: false }

test('the pump runs only when a message is waiting and nothing else is in flight', () => {
  assert.equal(canPumpQueue(ready), true)
})

test('each guard on its own is enough to hold the pump back', () => {
  assert.equal(canPumpQueue({ ...ready, pending: 0 }), false)
  assert.equal(canPumpQueue({ ...ready, running: true }), false)
  assert.equal(canPumpQueue({ ...ready, turnActive: true }), false)
  assert.equal(canPumpQueue({ ...ready, uiBlocked: true }), false)
})

test('a deeper queue does not override the guards', () => {
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: true, uiBlocked: false }), false)
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: false, uiBlocked: true }), false)
  assert.equal(canPumpQueue({ pending: 5, running: false, turnActive: false, uiBlocked: false }), true)
})
