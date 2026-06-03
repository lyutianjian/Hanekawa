import test from 'node:test'
import assert from 'node:assert/strict'
import { autoCompactIfNeeded, resetAutoCompactFailureState, summarizeRecordsForContinuation } from '../src/harness/compact.js'
import type { ModelProvider, SessionRecord } from '../src/harness/types.js'

test('autoCompactIfNeeded writes compact boundary when threshold is exceeded', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      assert.equal(request.tools?.length, 0)
      assert.match(request.messages[0]?.content ?? '', /old context/)
      assert.doesNotMatch(request.messages[0]?.content ?? '', /latest request/)
      return {
        content: 'compact summary',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
        },
      }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, true)
  assert.ok((result.metrics?.preTokens ?? 0) > 0)
  assert.ok((result.metrics?.postTokens ?? 0) > 0)
  assert.equal(typeof result.metrics?.compactDurationMs, 'number')
  assert.deepEqual(result.usage, {
    cacheReadInputTokens: 1,
    inputTokens: 2,
    outputTokens: 3,
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0]?.type, 'compact_boundary')
  assert.equal(appended[0]?.type === 'compact_boundary' ? appended[0].summary : '', 'compact summary')
  assert.equal(appended[0]?.type === 'compact_boundary' ? appended[0].postCompactRestore : undefined, 'pending')
})

test('autoCompactIfNeeded uses configured compact model when provided', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  let primaryCalled = false
  let compactModelSeen = ''
  const provider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalled = true
      return { content: 'wrong', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      compactModelSeen = request.model
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'primary-model',
    compactRuntime: {
      provider: compactProvider,
      model: 'cheap-model',
      modelKey: 'cheap',
      providerName: 'compact',
    },
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, true)
  assert.equal(primaryCalled, false)
  assert.equal(compactModelSeen, 'cheap-model')
})

test('autoCompactIfNeeded skips compacting below threshold', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'user',
    role: 'user',
    content: 'short',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  let called = false
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: '', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, false)
  assert.equal(called, false)
})

test('autoCompactIfNeeded prefers last model usage token count over rough estimates', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'user',
    role: 'user',
    content: 'short',
    createdAt: '2026-05-10T00:00:00.000Z',
  }, {
    type: 'message',
    id: 'latest-user',
    role: 'user',
    content: 'latest request',
    createdAt: '2026-05-10T00:01:00.000Z',
  }]
  let called = false
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return {
        content: 'usage-triggered summary',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    lastResponseTokenCount: 500,
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(called, true)
  assert.equal(result.compacted, true)
  assert.equal(appended[0]?.type, 'compact_boundary')
})

test('autoCompactIfNeeded adds pending records to last model usage token count', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'message',
      id: 'model-response',
      role: 'assistant',
      content: 'already counted by output usage '.repeat(500),
      createdAt: '2026-05-10T00:03:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'tool-result',
      toolUseId: 'tool-use',
      tool: 'Read',
      ok: true,
      content: 'pending tool output '.repeat(100),
      createdAt: '2026-05-10T00:04:00.000Z',
    },
  ]
  let called = false
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: 'pending-triggered summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: compactTestBudget(),
    lastResponseTokenCount: 400,
    lastResponseRecordCount: 3,
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(called, true)
  assert.equal(result.compacted, true)
  assert.equal(appended[0]?.type, 'compact_boundary')
})

test('summarizeRecordsForContinuation formats supported record types', async () => {
  let requestContent = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requestContent = request.messages[0]?.content ?? ''
      return { content: 'rewind summary', toolCalls: [] }
    },
  }

  const result = await summarizeRecordsForContinuation({
    records: [
      {
        type: 'message',
        id: 'user-1',
        role: 'user',
        content: 'user goal',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        type: 'at_mention_context',
        id: 'ctx-1',
        userMessageId: 'user-1',
        files: [],
        content: 'attached file context',
        createdAt: '2026-06-01T00:00:01.000Z',
      },
      {
        type: 'tool_use',
        id: 'tool-1',
        tool: 'Read',
        input: { filePath: 'src/a.ts' },
        riskLevel: 'safe',
        createdAt: '2026-06-01T00:00:02.000Z',
      },
      {
        type: 'tool_result',
        id: 'result-1',
        toolUseId: 'tool-1',
        tool: 'Read',
        ok: true,
        content: 'file body',
        createdAt: '2026-06-01T00:00:03.000Z',
      },
      {
        type: 'tool_approval',
        id: 'approval-1',
        tool: 'Bash',
        input: { command: 'git status' },
        approved: true,
        riskLevel: 'dangerous',
        createdAt: '2026-06-01T00:00:04.000Z',
      },
      {
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'prior summary',
        preTokens: 100,
        createdAt: '2026-06-01T00:00:05.000Z',
      },
    ],
    provider,
    model: 'fake-model',
    preTokens: 123,
  })

  assert.equal(result.content, 'rewind summary')
  assert.equal(result.preTokens, 123)
  assert.match(requestContent, /<pre_compact_tokens>123<\/pre_compact_tokens>/)
  assert.match(requestContent, /<message role="user">\nuser goal\n<\/message>/)
  assert.match(requestContent, /<at_mention_context user_message_id="user-1">/)
  assert.match(requestContent, /<tool_use name="Read" id="tool-1">/)
  assert.match(requestContent, /<tool_result name="Read" tool_use_id="tool-1" ok="true">/)
  assert.match(requestContent, /<tool_approval name="Bash" approved="true">/)
  assert.match(requestContent, /<compact_summary>\nprior summary\n<\/compact_summary>/)
})

test('summarizeRecordsForContinuation prefers compact runtime', async () => {
  let primaryCalled = false
  let compactModelSeen = ''
  const provider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalled = true
      return { content: 'wrong', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      compactModelSeen = request.model
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await summarizeRecordsForContinuation({
    records: [{
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'summarize me',
      createdAt: '2026-06-01T00:00:00.000Z',
    }],
    provider,
    model: 'primary-model',
    compactRuntime: {
      provider: compactProvider,
      model: 'compact-model',
      promptCacheRetention: '24h',
    },
  })

  assert.equal(primaryCalled, false)
  assert.equal(compactModelSeen, 'compact-model')
  assert.equal(result.content, 'compact summary')
})

test('autoCompactIfNeeded uses last response record id when record count is stale', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'tool_approval',
      id: 'approval-inserted-before-boundary',
      tool: 'Read',
      input: { file: 'example.ts' },
      approved: true,
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:01:30.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'already included in provider usage '.repeat(200),
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'message',
      id: 'model-response',
      role: 'assistant',
      content: 'already counted by output usage '.repeat(500),
      createdAt: '2026-05-10T00:03:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'tool-result',
      toolUseId: 'tool-use',
      tool: 'Read',
      ok: true,
      content: 'small pending output',
      _tokens: 5,
      createdAt: '2026-05-10T00:04:00.000Z',
    },
  ]
  let called = false
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: 'should not compact', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: compactTestBudget(),
    lastResponseTokenCount: 440,
    lastResponseRecordCount: 3,
    lastResponseRecordId: 'latest-user',
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, false)
  assert.equal(called, false)
})

test('autoCompactIfNeeded records telemetry and degrades when summary fails', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      throw new Error('compact model unavailable')
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-failure-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, false)
  assert.deepEqual(result.usage, {
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  })
  assert.equal(appended.length, 1)
  const telemetry = appended[0]
  assert.equal(telemetry?.type, 'compact_attempt_failed')
  assert.equal(telemetry?.type === 'compact_attempt_failed' ? telemetry.failureCount : 0, 1)
  assert.equal(telemetry?.type === 'compact_attempt_failed' ? telemetry.circuitOpen : true, false)
  assert.match(telemetry?.type === 'compact_attempt_failed' ? telemetry.error : '', /compact model unavailable/)
})

test('autoCompactIfNeeded ignores pre-compact hook failures', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let persistedFailureCount = 0
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'summary after hook failure', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-pre-hook-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
    onBeforeCompact: async () => {
      throw new Error('pre hook append failed')
    },
  })

  assert.equal(result.compacted, true)
  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded ignores post-compact hook failures after recording boundary', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let persistedFailureCount = 0
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'summary before hook failure', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-post-hook-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
    onAfterCompact: async () => {
      throw new Error('post hook append failed')
    },
  })

  assert.equal(result.compacted, true)
  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded opens circuit after three consecutive summary failures', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      throw new Error(`compact failure ${calls}`)
    },
  }
  const baseInput = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-circuit-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  await autoCompactIfNeeded(baseInput)
  await autoCompactIfNeeded(baseInput)
  await autoCompactIfNeeded(baseInput)
  const afterOpen = await autoCompactIfNeeded(baseInput)

  assert.equal(afterOpen.compacted, false)
  assert.equal(calls, 3)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 3)
  const lastTelemetry = appended.at(-1)
  assert.equal(lastTelemetry?.type, 'compact_attempt_failed')
  assert.equal(lastTelemetry?.type === 'compact_attempt_failed' ? lastTelemetry.failureCount : 0, 3)
  assert.equal(lastTelemetry?.type === 'compact_attempt_failed' ? lastTelemetry.circuitOpen : false, true)
})

test('autoCompactIfNeeded honors persisted compact failure count', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'should not compact', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'persisted-compact-circuit-test',
    getCompactFailureCount: async () => 3,
    setCompactFailureCount: async () => {
      throw new Error('should not write when circuit is already open')
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, false)
  assert.equal(calls, 0)
  assert.equal(appended.length, 0)
})

test('autoCompactIfNeeded deduplicates concurrent runs for the same circuit key', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  let releaseSummary: (() => void) | undefined
  let markSummaryStarted: (() => void) | undefined
  const summaryStarted = new Promise<void>((resolve) => {
    markSummaryStarted = resolve
  })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      markSummaryStarted?.()
      await new Promise<void>((release) => {
        releaseSummary = release
      })
      return { content: 'shared summary', toolCalls: [] }
    },
  }
  const input = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-dedup-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  const first = autoCompactIfNeeded(input)
  await summaryStarted
  const second = autoCompactIfNeeded(input)
  releaseSummary?.()
  const results = await Promise.all([first, second])

  assert.equal(results[0].compacted, true)
  assert.equal(results[1].compacted, true)
  assert.equal(calls, 1)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded deduplicates concurrent failure count updates', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  let persistedFailureCount = 0
  let releaseSummary: (() => void) | undefined
  let markSummaryStarted: (() => void) | undefined
  const summaryStarted = new Promise<void>((resolve) => {
    markSummaryStarted = resolve
  })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      markSummaryStarted?.()
      await new Promise<void>((release) => {
        releaseSummary = release
      })
      throw new Error('shared failure')
    },
  }
  const input = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-dedup-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count: number) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  const first = autoCompactIfNeeded(input)
  await summaryStarted
  const second = autoCompactIfNeeded(input)
  releaseSummary?.()
  await Promise.all([first, second])

  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 1)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 1)
})

function compactableRecords(): SessionRecord[] {
  return [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]
}

function compactTestBudget() {
  return {
    contextWindow: 600,
    summaryOutputTokens: 100,
    autoCompactBufferTokens: 50,
  }
}
