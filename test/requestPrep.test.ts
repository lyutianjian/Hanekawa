import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRecordsForRequest, prepareRecordsForRequestWithDiagnostics } from '../src/harness/requestPrep.js'
import { countTextTokens } from '../src/prompts/budget.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { recordsAfterAreOnlyInterruptSynthetic } from '../src/tui/interruptRollback.js'
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

test('prepareRecordsForRequest preserves old oversized tool results when aggregate budget allows', () => {
  const records: SessionRecord[] = [
    ...toolPair('old', 'Read', 'old output '.repeat(7_000), 0),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`new-${index}`, 'Read', 'new output '.repeat(10), index + 1))
  }

  const prepared = prepareRecordsForRequest(records, { contextWindow: 1_000_000, summaryOutputTokens: 0 })
  const oldResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'old-result')
  const newResult = prepared.find((record) => record.type === 'tool_result' && record.id === 'new-9-result')

  assert.equal(oldResult?.type, 'tool_result')
  assert.equal(oldResult.content, 'old output '.repeat(7_000))
  assert.equal(newResult?.type, 'tool_result')
  assert.match(newResult.content, /new output/)
  assert.doesNotMatch(records[1]?.type === 'tool_result' ? records[1].content : '', /summarized/)
})

test('prepareRecordsForRequest filters persisted sub-agent transcripts out of model context', () => {
  const records: SessionRecord[] = [
    {
      id: 'user-1',
      type: 'message',
      role: 'user',
      content: 'hello',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    {
      id: 'transcript-1',
      type: 'subagent_transcript',
      agentId: 'agent-1',
      subagentType: 'general',
      parentToolUseId: 'call-1',
      records: [{
        id: 'sub-user-1',
        type: 'message',
        role: 'user',
        content: 'private sub-agent prompt',
        createdAt: '2024-01-01T00:00:01.000Z',
      }],
      usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      createdAt: '2024-01-01T00:00:02.000Z',
    },
    {
      id: 'assistant-1',
      type: 'message',
      role: 'assistant',
      content: 'world',
      createdAt: '2024-01-01T00:00:03.000Z',
    },
  ]

  const prepared = prepareRecordsForRequest(records)

  assert.deepEqual(prepared.map((record) => record.id), ['user-1', 'assistant-1'])
})

test('prepareRecordsForRequest preserves latest compact boundary for context builder summary restore', async () => {
  const records: SessionRecord[] = [
    {
      id: 'old-user',
      type: 'message',
      role: 'user',
      content: 'old detail that should only survive through the summary',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      id: 'compact-1',
      type: 'compact_boundary',
      summary: 'summary visible after request prep',
      preTokens: 1234,
      postCompactRestore: 'consumed',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      id: 'new-user',
      type: 'message',
      role: 'user',
      content: 'new detail',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]

  const prepared = prepareRecordsForRequest(records)
  assert.deepEqual(prepared.map((record) => record.id), ['compact-1', 'new-user'])

  const built = await new ContextBuilder().build({
    records: prepared,
    tools: [],
    includeUserContext: false,
  })

  assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'))
  assert.ok(built.contextItems.some(
    (item) =>
      item.kind === 'message'
      && item.message.id === 'compact-1'
      && /Prior conversation was compacted/.test(item.message.content)
      && /summary visible after request prep/.test(item.message.content),
  ))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new-user'))
})

test('prepareRecordsForRequest keeps same-tool history when under token thresholds', () => {
  const records: SessionRecord[] = [
    ...toolPair('first', 'Read', 'first output', 0),
    ...toolPair('second', 'Read', 'second output', 1),
    ...toolPair('third', 'Read', 'third output', 2),
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

test('prepareRecordsForRequest does not mutate records with cached token counts', () => {
  const records: SessionRecord[] = [
    ...toolPair('first', 'Read', 'first output', 0),
  ]
  const result = records[1]
  assert.equal(result?.type, 'tool_result')
  assert.equal(result._tokens, undefined)

  prepareRecordsForRequest(records)

  // Token counts are computed but NOT cached on the record to avoid
  // cache coherency issues when record content changes after compaction.
  assert.equal(result._tokens, undefined)
})

test('prepareRecordsForRequest prefers cached tool result token counts', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'cached-call',
      tool: 'Grep',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'cached-result',
      toolUseId: 'cached-call',
      tool: 'Grep',
      ok: true,
      content: 'tiny',
      _tokens: 50_000,
      createdAt: '2026-05-10T00:00:00.000Z',
    },
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'Grep', `recent ${index}`, index + 1))
  }

  const prepared = prepareRecordsForRequest(
    records,
    { contextWindow: 20_000, summaryOutputTokens: 0 },
    new Date('2026-05-10T08:00:00.000Z'),
  )

  const result = prepared.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.match(result.content, /Grep 50000 tokens/)
})

test('prepareRecordsForRequest compacts protected recent tool results only when required by total budget', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'Read', 'large recent output '.repeat(3_000), index))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 100_000,
    summaryOutputTokens: 0,
  })

  assert.match(toolResultContent(prepared, 'recent-0'), /summarized/)
  assert.doesNotMatch(toolResultContent(prepared, 'recent-9'), /summarized/)
})

test('prepareRecordsForRequest does not compact older oversized tool results solely by age', () => {
  const records: SessionRecord[] = [
    ...toolPair('old', 'Read', 'large old output '.repeat(30_000), 0),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'Read', `recent ${index}`, index + 1))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 1_000_000,
    summaryOutputTokens: 0,
  })

  assert.doesNotMatch(toolResultContent(prepared, 'old'), /summarized/)
  for (let index = 0; index < 10; index++) {
    assert.doesNotMatch(toolResultContent(prepared, `recent-${index}`), /summarized/)
  }
})

test('prepareRecordsForRequest compacts older tool results when total tool-result budget is exceeded', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 4; index++) {
    records.push(...toolPair(`old-${index}`, 'Grep', 'budget output '.repeat(1_000), index))
  }
  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`recent-${index}`, 'Grep', `recent ${index}`, index + 4))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 10_000,
    summaryOutputTokens: 0,
  })

  assert.match(toolResultContent(prepared, 'old-0'), /summarized/)
  assert.match(toolResultContent(prepared, 'old-1'), /summarized/)
  assert.doesNotMatch(toolResultContent(prepared, 'old-3'), /summarized/)
  for (let index = 0; index < 10; index++) {
    assert.doesNotMatch(toolResultContent(prepared, `recent-${index}`), /summarized/)
  }
})

test('prepareRecordsForRequest caps tool-result budget at 200k tokens for large context windows', () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 25; index++) {
    records.push(...toolPair(`old-${index}`, 'Grep', 'budget output '.repeat(2_000), index))
  }

  const prepared = prepareRecordsForRequest(
    records,
    { contextWindow: 1_000_000, summaryOutputTokens: 0 },
    new Date('2026-05-10T08:00:00.000Z'),
  )

  assert.match(toolResultContent(prepared, 'old-0'), /summarized/)
})

test('prepareRecordsForRequest compacts oldest unprotected results first when over budget', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = [
    ...toolPairAt('first', 'Grep', 'large first output '.repeat(2_000), '2026-05-10T07:58:00.000Z'),
    ...toolPairAt('second', 'Grep', 'large second output '.repeat(2_000), '2026-05-10T07:59:00.000Z'),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPairAt(`recent-${index}`, 'Grep', `recent ${index}`, `2026-05-10T07:${String(index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 30_000,
    summaryOutputTokens: 0,
  }, now)

  assert.match(toolResultContent(prepared, 'first'), /summarized/)
  assert.doesNotMatch(toolResultContent(prepared, 'second'), /summarized/)
})

test('prepareRecordsForRequest leaves sub-hour oversized results alone unless total budget requires it', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = [
    ...toolPairAt('recent-large', 'Grep', 'large recent output '.repeat(29_000), '2026-05-10T07:30:00.000Z'),
  ]
  for (let index = 0; index < 10; index++) {
    records.push(...toolPairAt(`new-${index}`, 'Grep', `new ${index}`, `2026-05-10T07:${String(40 + index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 1_000_000,
    summaryOutputTokens: 0,
  }, now)

  assert.doesNotMatch(toolResultContent(prepared, 'recent-large'), /summarized/)
})

test('prepareRecordsForRequest compacts sub-hour results as a last resort for total budget', () => {
  const now = new Date('2026-05-10T08:00:00.000Z')
  const records: SessionRecord[] = []
  for (let index = 0; index < 12; index++) {
    records.push(...toolPairAt(`recent-large-${index}`, 'Grep', 'large recent output '.repeat(2_000), `2026-05-10T07:${String(index).padStart(2, '0')}:00.000Z`))
  }

  const prepared = prepareRecordsForRequest(records, {
    contextWindow: 40_000,
    summaryOutputTokens: 0,
  }, now)

  assert.match(toolResultContent(prepared, 'recent-large-0'), /summarized/)
  assert.doesNotMatch(toolResultContent(prepared, 'recent-large-11'), /summarized/)
})

test('prepareRecordsForRequest preserves valid tool_use and tool_result pairs', () => {
  const records: SessionRecord[] = [
    {
      type: 'tool_use',
      id: 'paired-call',
      tool: 'Grep',
      input: { pattern: 'hello' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'paired-result',
      toolUseId: 'paired-call',
      tool: 'Grep',
      ok: true,
      content: 'match',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
    {
      type: 'tool_use',
      id: 'orphan-call',
      tool: 'Grep',
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
      tool: 'Grep',
      ok: false,
      content: 'failed',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'orphan-call',
      tool: 'Grep',
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
      && record.tool === 'Grep'
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

test('recordsAfterAreOnlyInterruptSynthetic allows only interrupt bookkeeping after a user message', () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'do work',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      id: 'at-1',
      type: 'at_mention_context',
      userMessageId: 'user-1',
      files: [],
      content: '',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
    {
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-1',
      prompt: 'do work',
      remainingTasks: [],
      recoverable: true,
      createdAt: '2026-05-10T00:00:02.000Z',
    },
  ]

  assert.equal(recordsAfterAreOnlyInterruptSynthetic(records, 'user-1'), true)
})

test('recordsAfterAreOnlyInterruptSynthetic treats assistant and tool records as meaningful', () => {
  const base: SessionRecord = {
    type: 'message',
    id: 'user-1',
    role: 'user',
    content: 'do work',
    createdAt: '2026-05-10T00:00:00.000Z',
  }
  const assistant: SessionRecord = {
    type: 'message',
    id: 'assistant-1',
    role: 'assistant',
    content: 'partial answer',
    createdAt: '2026-05-10T00:00:01.000Z',
  }
  const toolUse: SessionRecord = {
    type: 'tool_use',
    id: 'call-1',
    tool: 'Read',
    input: { filePath: 'README.md' },
    riskLevel: 'safe',
    createdAt: '2026-05-10T00:00:01.000Z',
  }

  assert.equal(recordsAfterAreOnlyInterruptSynthetic([base, assistant], 'user-1'), false)
  assert.equal(recordsAfterAreOnlyInterruptSynthetic([base, toolUse], 'user-1'), false)
})
