import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRestoreOptions,
  formatDiffSummary,
  getCheckpointRenderKey,
  sortCheckpointsChronological,
  sortCheckpointsReverseChronological,
  truncateMessage,
} from '../src/tui/components/RestoreMode.js'
import type { CheckpointWithDiff } from '../src/services/fileHistory/types.js'

const emptyDiff = {
  fileCount: 0,
  additions: 0,
  deletions: 0,
  hasChanges: false,
}

function checkpoint(overrides: Partial<CheckpointWithDiff>): CheckpointWithDiff {
  return {
    messageId: 'msg',
    messageContent: 'message',
    timestamp: '2026-05-19T10:00:00.000Z',
    turnDiff: emptyDiff,
    restoreDiff: emptyDiff,
    isCurrent: false,
    ...overrides,
  }
}

describe('RestoreMode component logic', () => {
  it('sorts checkpoints in reverse chronological order', () => {
    const sorted = sortCheckpointsReverseChronological([
      checkpoint({ messageId: 'old', timestamp: '2026-05-19T10:00:00.000Z' }),
      checkpoint({ messageId: 'new', timestamp: '2026-05-19T12:00:00.000Z' }),
      checkpoint({ messageId: 'middle', timestamp: '2026-05-19T11:00:00.000Z' }),
    ])

    assert.deepEqual(sorted.map((item) => item.messageId), ['new', 'middle', 'old'])
  })

  it('sorts rewind checkpoint choices chronologically before the current row', () => {
    const sorted = sortCheckpointsChronological([
      checkpoint({ messageId: 'old', timestamp: '2026-05-19T10:00:00.000Z' }),
      checkpoint({ messageId: 'new', timestamp: '2026-05-19T12:00:00.000Z' }),
      checkpoint({ messageId: 'middle', timestamp: '2026-05-19T11:00:00.000Z' }),
    ])

    assert.deepEqual(sorted.map((item) => item.messageId), ['old', 'middle', 'new'])
  })

  it('uses message ids for render keys', () => {
    const keys = [
      checkpoint({ messageId: 'msg-1' }),
      checkpoint({ messageId: 'msg-2' }),
    ].map(getCheckpointRenderKey)

    assert.deepEqual(keys, ['msg-1', 'msg-2'])
    assert.equal(new Set(keys).size, 2)
  })

  it('builds four confirm options when code is unchanged', () => {
    assert.deepEqual(buildRestoreOptions(false).map((option) => option.decision), [
      'restore-conversation',
      'summarize-from-here',
      'summarize-up-to-here',
      'nevermind',
    ])
  })

  it('builds six confirm options when code can be restored', () => {
    assert.deepEqual(buildRestoreOptions(true).map((option) => option.decision), [
      'restore-code-and-conversation',
      'restore-conversation',
      'restore-code',
      'summarize-from-here',
      'summarize-up-to-here',
      'nevermind',
    ])
  })

  it('formats restore diff summaries with first file and remaining count', () => {
    assert.equal(formatDiffSummary({
      fileCount: 6,
      additions: 450,
      deletions: 588,
      firstFile: 'cosmic-sprouting-moore.md',
      hasChanges: true,
    }), '+450 -588 in cosmic-sprouting-moore.md and 5 other files')
  })

  it('truncates long messages with ASCII ellipsis', () => {
    const result = truncateMessage('a'.repeat(100), 80)
    assert.equal(result.length, 80)
    assert.equal(result.endsWith('...'), true)
  })
})
