import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProgressiveCompaction, estimateCurrentTokens } from '../src/harness/progressiveCompact.js'
import { CacheEditManager } from '../src/harness/cacheEditManager.js'
import type { SessionRecord } from '../src/harness/types.js'

function userTurn(index: number, content = `user ${index}`): SessionRecord {
  return {
    type: 'message',
    id: `user-${index}`,
    role: 'user',
    content,
    createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:00.000Z`,
  }
}

function assistantTurn(index: number, content = `assistant ${index}`): SessionRecord {
  return {
    type: 'message',
    id: `assistant-${index}`,
    role: 'assistant',
    content,
    createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:30.000Z`,
  }
}

function toolPair(index: number, content: string): SessionRecord[] {
  return [
    {
      type: 'tool_use',
      id: `call-${index}`,
      tool: 'Grep',
      input: { index },
      riskLevel: 'safe',
      createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:10.000Z`,
    },
    {
      type: 'tool_result',
      id: `result-${index}`,
      toolUseId: `call-${index}`,
      tool: 'Grep',
      ok: true,
      content,
      createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:11.000Z`,
    },
  ]
}

test('applyProgressiveCompaction microcompacts historical tool results before snipping', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 12; index++) {
    records.push(userTurn(index), ...toolPair(index, 'large output '.repeat(1_500)), assistantTurn(index))
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: {
      contextWindow: 80_000,
      summaryOutputTokens: 0,
      microCompactThresholdRatio: 0.65,
      snipThresholdRatio: 0.8,
    },
  })

  assert.equal(result.microCompacted, true)
  assert.equal(result.snipped, false)
  assert.match(
    toolResultContent(result.records, 'result-0'),
    /^\[summarized: Grep \d+ tokens\]/,
  )
  assert.doesNotMatch(
    toolResultContent(result.records, 'result-11'),
    /^\[summarized:/,
  )
})

test('applyProgressiveCompaction does not microcompact when all tool results are protected', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 10; index++) {
    records.push(userTurn(index), ...toolPair(index, 'large output '.repeat(250)), assistantTurn(index))
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 0,
      microCompactThresholdRatio: 0.2,
      snipThresholdRatio: 0.95,
    },
  })

  assert.equal(result.microCompacted, false)
  assert.equal(result.snipped, false)
  assert.equal(result.records.every((record) => record.type !== 'tool_result' || !record.content.startsWith('[summarized:')), true)
})

test('applyProgressiveCompaction skips snipping when microcompact recovers enough context', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 11; index++) {
    const pair = toolPair(index, 'tool output')
    const resultRecord = pair[1]
    if (resultRecord?.type === 'tool_result') {
      resultRecord._tokens = index === 0 ? 700 : 20
    }
    records.push(userTurn(index), ...pair, assistantTurn(index))
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: {
      contextWindow: 1_000,
      summaryOutputTokens: 0,
      microCompactThresholdRatio: 0.5,
      snipThresholdRatio: 0.8,
      snipMaxTurns: 6,
      snipHeadTurns: 2,
      snipTailTurns: 3,
    },
  })

  assert.equal(result.microCompacted, true)
  assert.equal(result.snipped, false)
  assert.match(toolResultContent(result.records, 'result-0'), /^\[summarized:/)
  assert.equal(result.records.some((record) => record.type === 'message' && /conversation snipped/.test(record.content)), false)
})

test('applyProgressiveCompaction snips middle turns after microcompact cannot recover enough context', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 10; index++) {
    records.push(userTurn(index, `user ${index} ${'chat '.repeat(500)}`), assistantTurn(index, `assistant ${index} ${'reply '.repeat(500)}`))
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 0,
      snipMaxTurns: 6,
      snipHeadTurns: 2,
      snipTailTurns: 3,
    },
  })

  assert.equal(result.snipped, true)
  assert.ok(result.records.some((record) => record.type === 'message' && /conversation snipped/.test(record.content)))
  assert.ok(result.records.some((record) => record.id === 'user-0'))
  assert.ok(result.records.some((record) => record.id === 'user-1'))
  assert.ok(result.records.some((record) => record.id === 'user-7'))
  assert.ok(result.records.some((record) => record.id === 'user-9'))
  assert.equal(result.records.some((record) => record.id === 'user-4'), false)
})

test('estimateCurrentTokens uses last response record id when record count is stale', () => {
  const records: SessionRecord[] = [
    userTurn(0),
    assistantTurn(0),
    {
      type: 'tool_approval',
      id: 'approval-inserted-before-boundary',
      tool: 'Read',
      input: { file: 'example.ts' },
      approved: true,
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:01:30.000Z',
    },
    userTurn(1, 'already included in provider usage '.repeat(200)),
    assistantTurn(1, 'already counted by output usage '.repeat(500)),
    {
      type: 'tool_result',
      id: 'result-pending',
      toolUseId: 'call-pending',
      tool: 'Read',
      ok: true,
      content: 'small pending output',
      _tokens: 7,
      createdAt: '2026-05-10T00:04:00.000Z',
    },
  ]

  const tokenCount = estimateCurrentTokens({
    records,
    lastResponseTokenCount: 100,
    lastResponseRecordCount: 3,
    lastResponseRecordId: 'user-1',
  })

  assert.equal(tokenCount, 107)
})

function toolResultContent(records: SessionRecord[], id: string): string {
  const record = records.find((item) => item.type === 'tool_result' && item.id === id)
  assert.equal(record?.type, 'tool_result')
  return record.content
}

test('applyProgressiveCompaction triggers time-based microcompact when gap exceeds threshold', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 8; index++) {
    records.push(userTurn(index), ...toolPair(index, 'large output '.repeat(500)), assistantTurn(index))
  }

  const result = applyProgressiveCompaction({
    records,
    now: new Date('2026-05-10T02:00:00.000Z'), // 2 hours after last assistant
  })

  assert.equal(result.microCompacted, true)
  // Last 5 tool results should be preserved
  assert.doesNotMatch(toolResultContent(result.records, 'result-7'), /Old tool result/)
  assert.doesNotMatch(toolResultContent(result.records, 'result-6'), /Old tool result/)
  assert.doesNotMatch(toolResultContent(result.records, 'result-5'), /Old tool result/)
  assert.doesNotMatch(toolResultContent(result.records, 'result-4'), /Old tool result/)
  assert.doesNotMatch(toolResultContent(result.records, 'result-3'), /Old tool result/)
  // Older ones should be cleared
  assert.match(toolResultContent(result.records, 'result-0'), /Old tool result content cleared/)
  assert.match(toolResultContent(result.records, 'result-2'), /Old tool result content cleared/)
})

test('applyProgressiveCompaction skips time-based microcompact when gap is under threshold', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 3; index++) {
    records.push(userTurn(index), ...toolPair(index, 'output '.repeat(500)), assistantTurn(index))
  }

  const result = applyProgressiveCompaction({
    records,
    now: new Date('2026-05-10T00:10:00.000Z'), // only 10 minutes after
  })

  assert.equal(result.microCompacted, false)
  // All tool results should be intact
  for (let index = 0; index < 3; index++) {
    assert.doesNotMatch(toolResultContent(result.records, `result-${index}`), /Old tool result/)
  }
})

test('applyProgressiveCompaction skips time-based microcompact when now is not provided', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 3; index++) {
    records.push(userTurn(index), ...toolPair(index, 'output '.repeat(500)), assistantTurn(index))
  }

  // Without `now`, time-based trigger should not fire regardless of gap
  const result = applyProgressiveCompaction({ records })

  assert.equal(result.microCompacted, false)
})

test('applyProgressiveCompaction time-based microcompact preserves at least 1 tool result', () => {
  const records: SessionRecord[] = [
    userTurn(0), ...toolPair(0, 'output'), assistantTurn(0),
  ]

  const result = applyProgressiveCompaction({
    records,
    now: new Date('2026-05-10T02:00:00.000Z'),
  })

  // Even with only 1 tool result, it should be preserved
  assert.equal(result.microCompacted, false)
  assert.doesNotMatch(toolResultContent(result.records, 'result-0'), /Old tool result/)
})

test('applyProgressiveCompaction cache-aware path registers tool results without mutating', () => {
  const manager = new CacheEditManager({ keepRecent: 2, triggerAfter: 3 })

  // Create enough tool results to trigger microcompact
  // Default microCompactThresholdRatio is 0.65 of (contextWindow - summaryOutputTokens)
  // With contextWindow: 10000, threshold = floor(10000 * 0.65) = 6500 tokens
  // Each tool result with 'large output '.repeat(1500) ≈ 18000 chars ≈ 4500 tokens
  // 5 tool results ≈ 22500 tokens, well above threshold
  const records: SessionRecord[] = []
  for (let i = 0; i < 20; i++) {
    records.push({
      type: 'tool_result',
      id: `tr-${i}`,
      toolUseId: `tu-${i}`,
      tool: 'Read',
      ok: true,
      content: 'large output '.repeat(1500),
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:00.000Z`,
    })
    records.push({
      type: 'message',
      id: `msg-${i}`,
      role: 'user',
      content: `question ${i}`,
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:30.000Z`,
    })
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: { contextWindow: 10000, summaryOutputTokens: 0 },
    cacheEditManager: manager,
  })

  // Records should NOT be mutated in cache-aware path
  assert.equal(result.microCompacted, false)
  assert.equal(result.cacheEditsPending, true)
  // Manager should have registered tool results
  assert.ok(manager.getRegisteredToolUseIds().size > 0)
})

test('applyProgressiveCompaction uses legacy path when no cacheEditManager', () => {
  // This tests existing behavior is unchanged
  const records: SessionRecord[] = []
  for (let i = 0; i < 20; i++) {
    records.push({
      type: 'tool_result',
      id: `tr-${i}`,
      toolUseId: `tu-${i}`,
      tool: 'Read',
      ok: true,
      content: 'large output '.repeat(1500),
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:00.000Z`,
    })
    records.push({
      type: 'message',
      id: `msg-${i}`,
      role: 'user',
      content: `question ${i}`,
      createdAt: `2026-06-16T00:${String(i).padStart(2, '0')}:30.000Z`,
    })
  }

  const result = applyProgressiveCompaction({
    records,
    contextManagement: { contextWindow: 40000, summaryOutputTokens: 2000 },
  })

  // Without cacheEditManager, legacy path should work
  assert.ok(result)
  assert.equal(result.cacheEditsPending, undefined)
})
