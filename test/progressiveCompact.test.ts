import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProgressiveCompaction } from '../src/harness/progressiveCompact.js'
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
    records.push(userTurn(index), ...toolPair(index, 'large output '.repeat(1_000)), assistantTurn(index))
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

function toolResultContent(records: SessionRecord[], id: string): string {
  const record = records.find((item) => item.type === 'tool_result' && item.id === id)
  assert.equal(record?.type, 'tool_result')
  return record.content
}
