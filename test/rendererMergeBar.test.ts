import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeBarView, mergeStat, type MergeBarEntry } from '../src/desktop/renderer/model/mergeBar.js'
import type { WireThreadMerge } from '../src/desktop/shellProtocol.js'

function merge(overrides: Partial<WireThreadMerge> = {}): WireThreadMerge {
  return {
    threadId: 't1',
    title: '修复登录',
    branch: 'thread/t1',
    added: 12,
    removed: 3,
    conflict: false,
    running: false,
    ...overrides,
  }
}

const NONE = new Set<string>()

test('the thread canvas shows only its own pending branch', () => {
  const view = mergeBarView({
    role: 'thread',
    threadId: 't2',
    projectName: 'alpha',
    merges: [merge(), merge({ threadId: 't2', branch: 'thread/t2' })],
    expanded: true,
    pending: NONE,
  })
  assert.equal(view.kind, 'single')
  assert.equal(view.kind === 'single' && view.entry.threadId, 't2')
  assert.equal(view.kind === 'single' && view.entry.branch, 'thread/t2')
})

test('a thread with no pending branch draws nothing', () => {
  const view = mergeBarView({
    role: 'thread',
    threadId: 'other',
    projectName: 'alpha',
    merges: [merge()],
    expanded: false,
    pending: NONE,
  })
  assert.deepEqual(view, { kind: 'hidden' })
})

test('the coordinator canvas summarises every branch and carries the expansion', () => {
  const view = mergeBarView({
    role: 'coordinator',
    projectName: 'alpha',
    merges: [merge(), merge({ threadId: 't2' }), merge({ threadId: 't3' })],
    expanded: true,
    pending: NONE,
  })
  assert.equal(view.kind, 'summary')
  assert.equal(view.kind === 'summary' && view.label, '3 个线程分支待合并')
  assert.equal(view.kind === 'summary' && view.expanded, true)
  assert.equal(view.kind === 'summary' && view.entries.length, 3)
})

test('an empty coordinator draws nothing', () => {
  const view = mergeBarView({ role: 'coordinator', projectName: 'alpha', merges: [], expanded: false, pending: NONE })
  assert.deepEqual(view, { kind: 'hidden' })
})

test('the stat uses a Unicode minus for removed lines', () => {
  assert.equal(mergeStat(12, 3), '+12 −3')
  const view = mergeBarView({ role: 'coordinator', projectName: 'a', merges: [merge({ added: 0, removed: 0 })], expanded: false, pending: NONE })
  assert.equal(view.kind === 'summary' && view.entries[0]!.stat, '+0 −0')
})

test('a running thread is shown but cannot be merged or resolved', () => {
  const entry = single(merge({ running: true }))
  assert.equal(entry.mergeEnabled, false)
  assert.equal(entry.resolveEnabled, false)
  assert.equal(entry.running, true)
})

test('a conflicted branch offers resolve, not merge', () => {
  const entry = single(merge({ conflict: true }))
  assert.equal(entry.mergeEnabled, false)
  assert.equal(entry.resolveEnabled, true)
  assert.equal(entry.conflict, true)
})

test('a clean idle branch offers merge only', () => {
  const entry = single(merge())
  assert.equal(entry.mergeEnabled, true)
  assert.equal(entry.resolveEnabled, false)
})

test('a branch with a merge in flight is pending and disabled', () => {
  const entry = mergeBarView({
    role: 'thread',
    threadId: 't1',
    projectName: 'alpha',
    merges: [merge()],
    expanded: false,
    pending: new Set(['t1']),
  })
  assert.equal(entry.kind === 'single' && entry.entry.pending, true)
  assert.equal(entry.kind === 'single' && entry.entry.mergeEnabled, false)
})

test('pending applies per thread in the summary, not to the whole bar', () => {
  const view = mergeBarView({
    role: 'coordinator',
    projectName: 'alpha',
    merges: [merge(), merge({ threadId: 't2' })],
    expanded: true,
    pending: new Set(['t2']),
  })
  assert.equal(view.kind === 'summary' && view.entries[0]!.mergeEnabled, true)
  assert.equal(view.kind === 'summary' && view.entries[1]!.mergeEnabled, false)
})

function single(m: WireThreadMerge): MergeBarEntry {
  const view = mergeBarView({ role: 'thread', threadId: m.threadId, projectName: 'alpha', merges: [m], expanded: false, pending: NONE })
  if (view.kind !== 'single') assert.fail('expected a single entry')
  return view.entry
}
