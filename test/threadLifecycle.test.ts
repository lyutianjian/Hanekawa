import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyLifecycle,
  effectiveThreadStatus,
  type ThreadStatus,
} from '../src/services/coordination/lifecycle.js'

const NOW = new Date('2026-10-10T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

function thread(status: ThreadStatus, lastActivityAt = ago(0)) {
  return { status, lastActivityAt }
}

test('running, needs-you, resolved and stale are never changed by time', () => {
  for (const status of ['running', 'needs-you', 'resolved', 'stale'] as const) {
    assert.equal(effectiveThreadStatus(thread(status, ago(30 * DAY)), NOW), status)
  }
})

test('idle just under 3 days stays idle, at exactly 3 days becomes quiet', () => {
  assert.equal(effectiveThreadStatus(thread('idle', ago(3 * DAY - 1)), NOW), 'idle')
  assert.equal(effectiveThreadStatus(thread('idle', ago(3 * DAY)), NOW), 'quiet')
})

test('at 7 days any time-driven status becomes resolved', () => {
  for (const status of ['idle', 'awaiting-coordinator', 'failed', 'interrupted', 'quiet'] as const) {
    assert.equal(effectiveThreadStatus(thread(status, ago(7 * DAY)), NOW), 'resolved')
  }
})

test('quietDays 0 disables the quiet rule', () => {
  const settings = { quietDays: 0 }
  assert.equal(effectiveThreadStatus(thread('idle', ago(5 * DAY)), NOW, settings), 'idle')
  assert.equal(effectiveThreadStatus(thread('idle', ago(7 * DAY)), NOW, settings), 'resolved')
})

test('autoResolveDays 0 disables the resolve rule', () => {
  const settings = { autoResolveDays: 0 }
  assert.equal(effectiveThreadStatus(thread('idle', ago(30 * DAY)), NOW, settings), 'quiet')
  assert.equal(effectiveThreadStatus(thread('failed', ago(30 * DAY)), NOW, settings), 'quiet')
})

test('custom thresholds are honoured', () => {
  const settings = { quietDays: 1, autoResolveDays: 2 }
  assert.equal(effectiveThreadStatus(thread('idle', ago(DAY / 2)), NOW, settings), 'idle')
  assert.equal(effectiveThreadStatus(thread('idle', ago(DAY)), NOW, settings), 'quiet')
  assert.equal(effectiveThreadStatus(thread('idle', ago(2 * DAY)), NOW, settings), 'resolved')
})

test('a stored quiet thread below the quiet threshold stays quiet', () => {
  assert.equal(effectiveThreadStatus(thread('quiet', ago(0)), NOW), 'quiet')
  assert.equal(effectiveThreadStatus(thread('quiet', ago(DAY)), NOW), 'quiet')
})

test('an invalid lastActivityAt returns the stored status unchanged', () => {
  assert.equal(effectiveThreadStatus(thread('idle', 'not-a-date'), NOW), 'idle')
  assert.equal(effectiveThreadStatus(thread('failed', 'not-a-date'), NOW), 'failed')
})

test('negative or non-finite settings fall back to defaults', () => {
  const negative = { quietDays: -1, autoResolveDays: -5 }
  assert.equal(effectiveThreadStatus(thread('idle', ago(2 * DAY)), NOW, negative), 'idle')
  assert.equal(effectiveThreadStatus(thread('idle', ago(3 * DAY)), NOW, negative), 'quiet')
  assert.equal(effectiveThreadStatus(thread('idle', ago(7 * DAY)), NOW, negative), 'resolved')

  const nonFinite = { quietDays: Number.NaN, autoResolveDays: Number.POSITIVE_INFINITY }
  assert.equal(effectiveThreadStatus(thread('idle', ago(3 * DAY)), NOW, nonFinite), 'quiet')
  assert.equal(effectiveThreadStatus(thread('idle', ago(7 * DAY)), NOW, nonFinite), 'resolved')
})

test('applyLifecycle returns effective statuses without mutating its input', () => {
  const input = [
    thread('idle', ago(4 * DAY)),
    thread('running', ago(30 * DAY)),
    thread('failed', ago(10 * DAY)),
  ]
  const snapshot = structuredClone(input)

  const output = applyLifecycle(input, NOW)

  assert.deepEqual(output.map((t) => t.status), ['quiet', 'running', 'resolved'])
  assert.deepEqual(input, snapshot)
  assert.notEqual(output[0], input[0])
})
