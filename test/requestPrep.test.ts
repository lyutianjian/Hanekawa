import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRecordsForRequest } from '../src/harness/requestPrep.js'
import type { SessionRecord } from '../src/harness/types.js'

test('prepareRecordsForRequest compacts old oversized tool results without mutating records', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'old-call',
      tool: 'readFile',
      input: { filePath: 'old.txt' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'old-result',
      toolUseId: 'old-call',
      tool: 'readFile',
      ok: true,
      content: 'old output '.repeat(100_000),
      createdAt: '2026-05-10T00:00:01.000Z',
    },
    {
      type: 'tool_use',
      id: 'new-call',
      tool: 'readFile',
      input: { filePath: 'new.txt' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'new-result',
      toolUseId: 'new-call',
      tool: 'readFile',
      ok: true,
      content: 'new output '.repeat(10),
      createdAt: '2026-05-10T00:01:01.000Z',
    },
  ]

  const prepared = prepareRecordsForRequest(records, { contextWindow: 100_000, summaryOutputTokens: 0 })
  const oldResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'old-result')
  const newResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'new-result')

  assert.equal(oldResult?.type, 'tool_result')
  assert.match(oldResult.content, /tool result compacted/)
  assert.equal(newResult?.type, 'tool_result')
  assert.match(newResult.content, /new output/)
  assert.doesNotMatch(records[1]?.type === 'tool_result' ? records[1].content : '', /tool result compacted/)
})

test('prepareRecordsForRequest preserves valid tool_use and tool_result pairs', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'paired-call',
      tool: 'grep',
      input: { pattern: 'hello' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'paired-result',
      toolUseId: 'paired-call',
      tool: 'grep',
      ok: true,
      content: 'match',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
    {
      type: 'tool_use',
      id: 'orphan-call',
      tool: 'grep',
      input: { pattern: 'missing' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:02.000Z',
    },
  ]

  const prepared = prepareRecordsForRequest(records)
  assert.ok(prepared.some((record) => record.type === 'tool_use' && record.id === 'paired-call'))
  assert.ok(prepared.some((record) => record.type === 'tool_result' && record.toolUseId === 'paired-call'))
  assert.ok(!prepared.some((record) => record.type === 'tool_use' && record.id === 'orphan-call'))
})
