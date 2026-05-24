import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRecordsForRequest, prepareRecordsForRequestWithDiagnostics } from '../src/harness/requestPrep.js'
import { countTextTokens } from '../src/prompts/budget.js'
import type { SessionRecord } from '../src/harness/types.js'

function toolPair(id: string, tool: string, content: string, minute: number): SessionRecord[] {
  const timestamp = `2026-05-10T00:${String(minute).padStart(2, '0')}:00.000Z`
  return toolPairAt(id, tool, content, timestamp)
}

function toolPairAt(id: string, tool: string, content: string, timestamp: string): SessionRecord[] {
  return [
    {
      type: 'tool_use',
      id: `${id}-call`,
      tool,
      input: { id },
      riskLevel: 'safe',
      createdAt: timestamp,
    },
    {
      type: 'tool_result',
      id: `${id}-result`,
      toolUseId: `${id}-call`,
      tool,
      ok: true,
      content,
      createdAt: timestamp,
    },
  ]
}

function toolResultContent(records: SessionRecord[], id: string): string {
  const record = records.find((item) => item.type === 'tool_result' && item.id === `${id}-result`)
  assert.equal(record?.type, 'tool_result')
  return record.content
}

test('prepareRecordsForRequest compacts old oversized tool results without mutating records', () => {
  const records: SessionRecord[] = [
    ...toolPair('old', 'readFile', 'old output '.repeat(100_000), 0),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`new-${index}`, 'readFile', 'new output '.repeat(10), index + 1))
  }

  const prepared = prepareRecordsForRequest(records, { contextWindow: 100_000, summaryOutputTokens: 0 })
  const oldResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'old-result')
  const newResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'new-9-result')

  assert.equal(oldResult?.type, 'tool_result')
  assert.match(oldResult.content, /tool result compacted/)
  assert.equal(newResult?.type, 'tool_result')
  assert.match(newResult.content, /new output/)
  assert.doesNotMatch(records[1]?.type === 'tool_result' ? records[1].content : '', /tool result compacted/)
})

test('prepareRecordsForRequest keeps same-tool history when under token thresholds', () => {
  const records: SessionRecord[] = [
    ...toolPair('first', 'readFile', 'first output', 0),
    ...toolPair('second', 'readFile', 'second output', 1),
    ...toolPair('third', 'readFile', 'third output', 2),
  ]

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 100_000,
    summaryOutputTokens: 0,
  })

  assert.equal(toolResultContent(prepared, 'first'), 'first output')
  assert.equal(toolResultContent(prepared, 'second'), 'second output')
  assert.equal(toolResultContent(prepared, 'third'), 'third output')
})

test('prepareRecordsForRequest strips thinking blocks outside recent assistant turns', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 5; index++) {
    records.push({
      type: 'message',
      id: `assistant-${index}`,
      role: 'assistant',
      content: `message ${index}`,
      thinkingBlocks: [{
        type: 'thinking',
        thinking: `thinking ${index}`,
        signature: `signature-${index}`,
      }],
      createdAt: `2026-05-10T00:0${index}:00.000Z`,
    })
  }

  const prepared = prepareRecordsForRequest(records)
  const assistantMessages = prepared.filter(
    (record): record is SessionRecord & { type: 'message'; role: 'assistant' } =>
      record.type === 'message' && record.role === 'assistant',
  )

  assert.equal(assistantMessages.length, 5)
  assert.equal(assistantMessages[0]?.thinkingBlocks, undefined)
  assert.equal(assistantMessages[1]?.thinkingBlocks, undefined)
  assert.equal(assistantMessages[2]?.thinkingBlocks?.[0]?.signature, 'signature-2')
  assert.equal(assistantMessages[3]?.thinkingBlocks?.[0]?.signature, 'signature-3')
  assert.equal(assistantMessages[4]?.thinkingBlocks?.[0]?.signature, 'signature-4')
  assert.equal(records[0]?.type === 'message' ? records[0].thinkingBlocks?.[0]?.signature : undefined, 'signature-0')
})

test('prepareRecordsForRequestWithDiagnostics can strip all assistant thinking for outbound requests', () => {
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'assistant-1',
    role: 'assistant',
    content: 'message',
    thinkingBlocks: [{
      type: 'thinking',
      thinking: 'private reasoning',
      signature: 'signature-1',
    }],
    createdAt: '2026-05-10T00:00:00.000Z',
  }]

  const prepared = prepareRecordsForRequestWithDiagnostics(
    records,
    {},
    new Date('2026-05-10T00:00:00.000Z'),
    { recentAssistantThinkingTurnsToKeep: 0 },
  ).records

  assert.equal(prepared[0]?.type === 'message' ? prepared[0].thinkingBlocks : undefined, undefined)
  assert.equal(records[0]?.type === 'message' ? records[0].thinkingBlocks?.[0]?.signature : undefined, 'signature-1')
})

test('prepareRecordsForRequest caches tool result token counts on records', () => {
  const records: SessionRecord[] = [
    ...toolPair('first', 'readFile', 'first output', 0),
  ]
  const result = records[1]
  assert.equal(result?.type, 'tool_result')
  assert.equal(result._tokens, undefined)

  prepareRecordsForRequest(records)

  assert.equal(result._tokens, countTextTokens('readFile\nfirst output'))
})

test('prepareRecordsForRequest prefers cached tool result token counts', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'cached-call',
      tool: 'grep',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'cached-result',
      toolUseId: 'cached-call',
      tool: 'grep',
      ok: true,
      content: 'tiny',
      _tokens: 50_000,
      createdAt: '2026-05-10T00:00:00.000Z',
    },
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'grep', `recent ${index}`, index + 1))
  }

  const prepared = prepareRecordsForRequest(
    records,
    { contextWindow: 20_000, summaryOutputTokens: 0 },
    new Date('2026-05-10T08:00:00.000Z'),
  )

  const result = prepared.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.match(result.content, /approximately 50000 tokens/)
})

test('prepareRecordsForRequest keeps the 10 most recent tool results even when oversized', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'readFile', 'large recent output '.repeat(30_000), index))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 1_000,
    summaryOutputTokens: 0,
  })

  for (let index = 0; index < 10; index++) {
    assert.doesNotMatch(toolResultContent(prepared, `recent-${index}`), /tool result compacted/)
  }
})

test('prepareRecordsForRequest compacts oversized tool results older than the 10 most recent', () => {
  const records: SessionRecord[] = [
    ...toolPair('old', 'readFile', 'large old output '.repeat(30_000), 0),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'readFile', `recent ${index}`, index + 1))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 1_000_000,
    summaryOutputTokens: 0,
  })

  assert.match(toolResultContent(prepared, 'old'), /tool result compacted/)
  for (let index = 0; index < 10; index++) {
    assert.doesNotMatch(toolResultContent(prepared, `recent-${index}`), /tool result compacted/)
  }
})

test('prepareRecordsForRequest compacts older tool results when total tool-result budget is exceeded', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 4; index++) {
    records.push(...toolPair(`old-${index}`, 'grep', 'budget output '.repeat(1_000), index))
  }
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'grep', `recent ${index}`, index + 4))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 10_000,
    summaryOutputTokens: 0,
  })

  assert.match(toolResultContent(prepared, 'old-0'), /tool result compacted/)
  assert.match(toolResultContent(prepared, 'old-1'), /tool result compacted/)
  assert.doesNotMatch(toolResultContent(prepared, 'old-3'), /tool result compacted/)
  for (let index = 0; index < 10; index++) {
    assert.doesNotMatch(toolResultContent(prepared, `recent-${index}`), /tool result compacted/)
  }
})

test('prepareRecordsForRequest caps tool-result budget at 200k tokens for large context windows', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 25; index++) {
    records.push(...toolPair(`old-${index}`, 'grep', 'budget output '.repeat(2_000), index))
  }

  const prepared = prepareRecordsForRequest(
    records,
    { contextWindow: 1_000_000, summaryOutputTokens: 0 },
    new Date('2026-05-10T08:00:00.000Z'),
  )

  assert.match(toolResultContent(prepared, 'old-0'), /tool result compacted/)
})

test('prepareRecordsForRequest prefers compacting results older than four hours before one hour', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = [
    ...toolPairAt('older-than-four', 'grep', 'large old output '.repeat(2_000), '2026-05-10T03:00:00.000Z'),
    ...toolPairAt('older-than-one', 'grep', 'large middle output '.repeat(2_000), '2026-05-10T06:30:00.000Z'),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPairAt(`recent-${index}`, 'grep', `recent ${index}`, `2026-05-10T07:${String(index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 25_000,
    summaryOutputTokens: 0,
  }, now)

  assert.match(toolResultContent(prepared, 'older-than-four'), /tool result compacted/)
  assert.doesNotMatch(toolResultContent(prepared, 'older-than-one'), /tool result compacted/)
})

test('prepareRecordsForRequest leaves sub-hour oversized results alone unless total budget requires it', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = [
    ...toolPairAt('recent-large', 'grep', 'large recent output '.repeat(30_000), '2026-05-10T07:30:00.000Z'),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPairAt(`new-${index}`, 'grep', `new ${index}`, `2026-05-10T07:${String(40 + index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 1_000_000,
    summaryOutputTokens: 0,
  }, now)

  assert.doesNotMatch(toolResultContent(prepared, 'recent-large'), /tool result compacted/)
})

test('prepareRecordsForRequest compacts sub-hour results as a last resort for total budget', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = []
  for (let index = 0; index < 12; index++) {
    records.push(...toolPairAt(`recent-large-${index}`, 'grep', 'large recent output '.repeat(4_000), `2026-05-10T07:${String(index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 40_000,
    summaryOutputTokens: 0,
  }, now)

  assert.match(toolResultContent(prepared, 'recent-large-0'), /tool result compacted/)
  assert.doesNotMatch(toolResultContent(prepared, 'recent-large-11'), /tool result compacted/)
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
  assert.ok(prepared.some((record) => record.type === 'tool_use' && record.id === 'orphan-call'))
  assert.ok(prepared.some(
    (record) =>
      record.type === 'tool_result'
      && record.toolUseId === 'orphan-call'
      && record.ok === false
      && record.content === '[Tool result was lost in transport.]',
  ))
})

test('prepareRecordsForRequestWithDiagnostics reports repaired orphan tool records', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_result',
      id: 'orphan-result',
      toolUseId: 'missing-call',
      tool: 'grep',
      ok: false,
      content: 'failed',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'orphan-call',
      tool: 'grep',
      input: { pattern: 'missing' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
  ]

  const result = prepareRecordsForRequestWithDiagnostics(records)
  assert.deepEqual(result.records.map((record) => record.type), [
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
  ])
  assert.ok(result.records.some(
    (record) =>
      record.type === 'tool_use'
      && record.id === 'missing-call'
      && record.tool === 'grep'
      && JSON.stringify(record.input) === '{}',
  ))
  assert.ok(result.records.some(
    (record) =>
      record.type === 'tool_result'
      && record.toolUseId === 'orphan-call'
      && record.ok === false
      && record.content === '[Tool result was lost in transport.]',
  ))
  assert.equal(result.diagnostics.length, 2)
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.code === 'tool_protocol_repaired'))
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.message.startsWith('Inserted synthetic')))
})
