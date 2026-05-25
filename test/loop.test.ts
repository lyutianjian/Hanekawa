import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { SessionMetricInput } from '../src/harness/metrics.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, ModelRequest, SessionRecord, Tool } from '../src/harness/types.js'
import { FallbackTriggeredError } from '../src/config/retry.js'
import { resetAutoCompactFailureState } from '../src/harness/compact.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  resetCacheBreakDetection,
} from '../src/harness/cacheBreakDetection.js'

function recordStreamFor(
  records: SessionRecord[],
  metrics?: Array<Record<string, unknown>>,
  onLoad?: () => void,
): RecordStream {
  return {
    load: async () => {
      onLoad?.()
      return records
    },
    append: async (record) => { records.push(record) },
    update: async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index < 0) return
      const record = records[index]
      if (!record) return
      records[index] = update(record)
    },
    ...(metrics
      ? { appendMetric: async (metric: SessionMetricInput) => { metrics.push(metric) } }
      : {}),
  }
}

test('agent loop appends user and assistant messages', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      assert.ok(!('maxTokens' in request))
      assert.equal(request.cacheSource, 'agent:s1')
      return {
        content: 'hello back',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 10,
          inputTokens: 20,
          outputTokens: 30,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, metrics),
  })
  const response = await loop.run('hello')
  assert.equal(response.content, 'hello back')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 10,
    inputTokens: 20,
    outputTokens: 30,
  })
  assert.equal(records.filter((record) => record.type === 'message').length, 2)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0]?.event, 'turn')
  assert.equal(metrics[0]?.model, 'fake-model')
  assert.equal(metrics[0]?.response_tokens, 30)
  assert.equal(metrics[0]?.cache_read_tokens, 10)
  assert.equal(metrics[0]?.tool_calls, 0)
})

test('agent loop updates records cache only after record stream append succeeds', async () => {
  const records: SessionRecord[] = []
  let failAssistantAppend = true
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      providerCalls += 1
      if (providerCalls === 2) {
        assert.equal(request.contextItems?.some(
          (item) => item.kind === 'message'
            && item.message.role === 'assistant'
            && item.message.content === 'lost assistant',
        ), false)
      }
      return {
        content: providerCalls === 1 ? 'lost assistant' : 'persisted assistant',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const recordStream: RecordStream = {
    load: async () => records,
    append: async (record) => {
      if (
        failAssistantAppend
        && record.type === 'message'
        && record.role === 'assistant'
        && record.content === 'lost assistant'
      ) {
        throw new Error('disk full')
      }
      records.push(record)
    },
  }
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream,
  })

  await assert.rejects(loop.run('first'), /disk full/)
  failAssistantAppend = false
  const response = await loop.run('second')

  assert.equal(response.content, 'persisted assistant')
  assert.equal(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'lost assistant'), false)
})

test('agent loop marks cached tool protocol dirty after tool record append', async () => {
  const records: SessionRecord[] = []
  let providerCalls = 0
  let failToolResultAppend = true
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      providerCalls += 1
      if (providerCalls === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
        }
      }
      assert.ok(request.contextItems?.some(
        (item) => item.kind === 'tool_result'
          && item.toolUseId === 'call-1'
          && /lost in transport/.test(item.content),
      ))
      return { content: 'recovered', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => {
      if (failToolResultAppend && record.type === 'tool_result') {
        throw new Error('tool result append failed')
      }
      records.push(record)
    },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await assert.rejects(loop.run('first'), /tool result append failed/)
  failToolResultAppend = false
  const response = await loop.run('second')

  assert.equal(response.content, 'recovered')
})

test('agent loop appends userPromptSubmit hook stdout before first model request', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.role === 'user'
          && /branch: test-branch/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      userPromptSubmit: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('branch: test-branch')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(records.some((record) => record.type === 'message' && /userPromptSubmit hook output/.test(record.content)))
})

test('agent loop appends stop hook stdout before returning', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('typecheck: failed')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  const messages = records.filter((record) => record.type === 'message')
  assert.equal(messages.at(-1)?.role, 'user')
  assert.match(messages.at(-1)?.content ?? '', /stop hook output/)
  assert.match(messages.at(-1)?.content ?? '', /typecheck: failed/)
})

test('agent loop continues when stop hook reports a blocking error', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'first',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 1,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.role === 'user'
          && /stop hook blocking error:\nfix it/.test(item.message.content),
      ))
      return {
        content: 'second',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 20,
          outputTokens: 2,
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); if (data.response === 'first') { console.error('BLOCKING: fix it'); process.exitCode = 1 } })"`,
      }],
    },
    recordStream: recordStreamFor(records, metrics),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'second')
  assert.equal(callCount, 2)
  assert.deepEqual(metrics.filter((metric) => metric.event === 'turn').map((metric) => metric.response_tokens), [1, 2])
  assert.ok(records.some((record) => record.type === 'message' && /stop hook blocking error:\nfix it/.test(record.content)))
  assert.equal(records.some((record) => record.type === 'message' && /Hook failures:/.test(record.content)), false)
})

test('agent loop respects stop hook preventContinuation before blocking errors', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('__HANEKAWA_HOOK__'); console.log(JSON.stringify({ preventContinuation: true })); console.error('BLOCKING: should not continue')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  assert.equal(callCount, 1)
  assert.equal(records.some((record) => record.type === 'message' && /stop hook blocking error/.test(record.content)), false)
})

test('agent loop annotates records from one user turn with the same turnId', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  const turnIds = new Set(
    records
      .filter((record) => record.type !== 'tool_approval')
      .map((record) => record.turnId),
  )
  assert.equal(turnIds.size, 1)
  assert.equal(typeof [...turnIds][0], 'string')
})

test('agent loop emits cache break metrics from provider responses', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 100,
          inputTokens: 20,
          outputTokens: 5,
        },
        cacheBreak: {
          tokenDrop: 5000,
          prevCacheRead: 5100,
          currentCacheRead: 100,
          reasons: ['tool_schemas_changed'],
          source: 'agent:s1',
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, metrics),
  })

  await loop.run('hello')

  const cacheBreakMetric = metrics.find((metric) => metric.event === 'cache_break')
  assert.deepEqual(cacheBreakMetric?.reasons, ['tool_schemas_changed'])
  assert.equal('reason' in (cacheBreakMetric ?? {}), false)
  assert.equal(cacheBreakMetric?.drop_tokens, 5000)
  assert.equal(cacheBreakMetric?.source, 'agent:s1')
})


test('agent loop sends tool result into the next model request', async () => {
  const records: SessionRecord[] = []
  const seenRequests: ModelRequest[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      seenRequests.push(request)
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'I will use the echo tool.',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 1,
            inputTokens: 2,
            outputTokens: 3,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.role === 'assistant' && item.message.content === 'I will use the echo tool.'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1' && item.content === '{"value":"hello"}'))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 4,
          inputTokens: 5,
          outputTokens: 6,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  let loadRecordsCount = 0
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })
  const response = await loop.run('hello')
  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 5,
    inputTokens: 7,
    outputTokens: 9,
  })
  assert.equal(seenRequests.length, 2)
  assert.equal(loadRecordsCount, 1)
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'I will use the echo tool.'))
  assert.ok(records.some((record) => record.type === 'tool_use'))
  assert.ok(records.some((record) => record.type === 'tool_result'))
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'call-1').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result' && record.toolUseId === 'call-1').length, 1)
  assert.equal(records.filter((record) => record.type === 'message' && record.role === 'tool').length, 0)
})

test('agent loop generates tool-use summary with compact model for the next request', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  let summaryModelSeen = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && /Summary of recent tool use/.test(item.message.content)
          && /echo returned hello/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      summaryModelSeen = request.model
      assert.equal(request.cacheSource, 'tool_use_summary')
      assert.match(request.messages[0]?.content ?? '', /"value":"hello"/)
      return { content: 'echo returned hello', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    compactModel: {
      provider: compactProvider,
      model: 'cheap-model',
      modelKey: 'cheap',
      providerName: 'compact',
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  assert.equal(summaryModelSeen, 'cheap-model')
  assert.ok(records.some((record) => record.type === 'tool_use_summary' && record.summary === 'echo returned hello'))
})

test('agent loop consumes pending post-compact restore after a successful build', async () => {
  const records: SessionRecord[] = [{
    type: 'compact_boundary',
    id: 'compact-1',
    summary: 'summary',
    preTokens: 100,
    postCompactRestore: 'pending',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.id === 'meta:post-compact-restore'
          && /# restoredSkill debugging\nDebug skill body/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: {
      cwd: process.cwd(),
      sessionId: 's1',
      readFiles: new Set(),
      invokedSkills: new Map([['debugging', { content: 'Debug skill body', timestamp: 1 }]]),
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  const boundary = records.find((record) => record.id === 'compact-1')
  assert.equal(boundary?.type, 'compact_boundary')
  assert.equal(boundary?.type === 'compact_boundary' ? boundary.postCompactRestore : undefined, 'consumed')
})

test('agent loop preserves tool result association for mixed safe and unsafe order', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'unsafe-call', name: 'unsafeTool', input: {} },
            { id: 'safe-call', name: 'safeTool', input: {} },
          ],
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'unsafe-call' && item.content === 'unsafe-result'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'safe-call' && item.content === 'safe-result'))
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [
    {
      name: 'unsafeTool',
      description: 'unsafe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      execute: async () => ({ ok: true, content: 'unsafe-result' }),
    },
    {
      name: 'safeTool',
      description: 'safe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ ok: true, content: 'safe-result' }),
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'unsafe-call').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'safe-call').length, 1)
})

test('agent loop runs consecutive safe calls concurrently and unsafe calls as barriers', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'safe-a-call', name: 'safeA', input: {} },
            { id: 'safe-b-call', name: 'safeB', input: {} },
            { id: 'unsafe-call', name: 'unsafe', input: {} },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const tools: Tool[] = [
    {
      name: 'safeA',
      description: 'safe a',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        events.push('safeA:start')
        await delay(20)
        events.push('safeA:end')
        return { ok: true, content: 'a' }
      },
    },
    {
      name: 'safeB',
      description: 'safe b',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        events.push('safeB:start')
        await delay(5)
        events.push('safeB:end')
        return { ok: true, content: 'b' }
      },
    },
    {
      name: 'unsafe',
      description: 'unsafe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      execute: async () => {
        events.push('unsafe:start')
        return { ok: true, content: 'unsafe' }
      },
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(events.indexOf('safeB:start') > events.indexOf('safeA:start'))
  assert.ok(events.indexOf('safeB:start') < events.indexOf('safeA:end'))
  assert.ok(events.indexOf('unsafe:start') > events.indexOf('safeA:end'))
  assert.ok(events.indexOf('unsafe:start') > events.indexOf('safeB:end'))
})

test('agent loop runs read-only Agent calls concurrently by subagent_type', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using agents',
          toolCalls: [
            { id: 'explore-a-call', name: 'Agent', input: { task: 'map a', subagent_type: 'explore' } },
            { id: 'explore-b-call', name: 'Agent', input: { task: 'map b', subagent_type: 'explore' } },
            { id: 'explore-c-call', name: 'Agent', input: { task: 'map c', subagent_type: 'explore' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const agentTool: Tool = {
    name: 'Agent',
    description: 'agent',
    inputSchema: z.object({
      task: z.string(),
      subagent_type: z.enum(['general', 'explore', 'plan', 'verification']),
    }).strict(),
    riskLevel: 'safe',
    isConcurrencySafeInput(input) {
      const parsed = this.inputSchema.safeParse(input)
      return parsed.success && ['general', 'explore', 'plan'].includes((parsed.data as { subagent_type: string }).subagent_type)
    },
    execute: async (input) => {
      const { task } = input as { task: string }
      events.push(`${task}:start`)
      await delay(task.endsWith('a') ? 20 : 5)
      events.push(`${task}:end`)
      return { ok: true, content: task }
    },
  }
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(events.indexOf('map b:start') > events.indexOf('map a:start'))
  assert.ok(events.indexOf('map b:start') < events.indexOf('map a:end'))
  assert.ok(events.indexOf('map c:start') > events.indexOf('map a:start'))
  assert.ok(events.indexOf('map c:start') < events.indexOf('map a:end'))
})

test('agent loop keeps verification Agent calls serial', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using agents',
          toolCalls: [
            { id: 'verification-a-call', name: 'Agent', input: { task: 'verify a', subagent_type: 'verification' } },
            { id: 'verification-b-call', name: 'Agent', input: { task: 'verify b', subagent_type: 'verification' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const agentTool: Tool = {
    name: 'Agent',
    description: 'agent',
    inputSchema: z.object({
      task: z.string(),
      subagent_type: z.enum(['general', 'explore', 'plan', 'verification']),
    }).strict(),
    riskLevel: 'safe',
    isConcurrencySafeInput(input) {
      const parsed = this.inputSchema.safeParse(input)
      return parsed.success && ['general', 'explore', 'plan'].includes((parsed.data as { subagent_type: string }).subagent_type)
    },
    execute: async (input) => {
      const { task } = input as { task: string }
      events.push(`${task}:start`)
      await delay(20)
      events.push(`${task}:end`)
      return { ok: true, content: task }
    },
  }
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(events.indexOf('verify b:start') > events.indexOf('verify a:end'))
})

test('agent loop keeps verification Agent calls as barriers around read-only agents', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using agents',
          toolCalls: [
            { id: 'verification-call', name: 'Agent', input: { task: 'verify', subagent_type: 'verification' } },
            { id: 'explore-call', name: 'Agent', input: { task: 'explore', subagent_type: 'explore' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const agentTool: Tool = {
    name: 'Agent',
    description: 'agent',
    inputSchema: z.object({
      task: z.string(),
      subagent_type: z.enum(['general', 'explore', 'plan', 'verification']),
    }).strict(),
    riskLevel: 'safe',
    isConcurrencySafeInput(input) {
      const parsed = this.inputSchema.safeParse(input)
      return parsed.success && ['general', 'explore', 'plan'].includes((parsed.data as { subagent_type: string }).subagent_type)
    },
    execute: async (input) => {
      const { task } = input as { task: string }
      events.push(`${task}:start`)
      await delay(task === 'verify' ? 20 : 1)
      events.push(`${task}:end`)
      return { ok: true, content: task }
    },
  }
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(events.indexOf('explore:start') > events.indexOf('verify:end'))
})

test('agent loop keeps mislabeled write-like tools as barriers', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'write-a-call', name: 'writeA', input: {} },
            { id: 'write-b-call', name: 'writeB', input: {} },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const tools: Tool[] = [
    {
      name: 'writeA',
      description: 'mislabeled write a',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      isConcurrencySafe: true,
      execute: async () => {
        events.push('writeA:start')
        await delay(20)
        events.push('writeA:end')
        return { ok: true, content: 'a' }
      },
    },
    {
      name: 'writeB',
      description: 'mislabeled write b',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      isConcurrencySafe: true,
      execute: async () => {
        events.push('writeB:start')
        return { ok: true, content: 'b' }
      },
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(events.indexOf('writeB:start') > events.indexOf('writeA:end'))
})

test('agent loop appends reminder when all tool calls fail', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'fail-call', name: 'failTool', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'failTool',
    description: 'fail',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: false, content: 'failed' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run('hello')

  assert.ok(records.some((record) => record.type === 'message' && /All tool calls in the previous turn failed/.test(record.content)))
})

test('agent loop auto-compacts without preparing records twice in the same iteration', async () => {
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
  ]
  let callCount = 0
  let loadRecordsCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        assert.equal(request.tools?.length, 0)
        assert.equal(request.cacheSource, 'compact')
        return {
          content: 'summary',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 10,
            inputTokens: 20,
            outputTokens: 30,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id.startsWith('meta:user-context')))
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'))
      assert.ok(!contextItems.some((item) => item.kind === 'message' && /Prior conversation was compacted/.test(item.message.content)))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })

  const response = await loop.run('latest request')

  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 11,
    inputTokens: 22,
    outputTokens: 33,
  })
  assert.equal(callCount, 2)
  assert.equal(loadRecordsCount, 1)
  assert.ok(records.some((record) => record.type === 'compact_boundary'))
})

test('agent loop runs preCompact and postCompact hooks around successful compaction', async () => {
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
  ]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        return { content: 'summary', toolCalls: [] }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const hookCommand = `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log(data.hook + ':' + data.trigger) })"`
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    hooks: {
      preCompact: [{ matcher: 'auto', command: hookCommand }],
      postCompact: [{ matcher: 'auto', command: hookCommand }],
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run('latest request')

  const preHookIndex = records.findIndex((record) => record.type === 'message' && /preCompact hook output/.test(record.content))
  const boundaryIndex = records.findIndex((record) => record.type === 'compact_boundary')
  const postHookIndex = records.findIndex((record) => record.type === 'message' && /postCompact hook output/.test(record.content))
  assert.ok(preHookIndex >= 0)
  assert.ok(boundaryIndex > preHookIndex)
  assert.ok(postHookIndex > boundaryIndex)
  assert.match(records[preHookIndex]?.type === 'message' ? records[preHookIndex].content : '', /preCompact:auto/)
  assert.match(records[postHookIndex]?.type === 'message' ? records[postHookIndex].content : '', /postCompact:auto/)
})

test('agent loop checks auto-compact before later model requests in a tool loop', async () => {
  const records: SessionRecord[] = []
  const providerCalls: string[] = []
  let loadRecordsCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        providerCalls.push('compact')
        assert.equal(request.cacheSource, 'compact')
        return {
          content: 'second-iteration summary',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 10,
            inputTokens: 20,
            outputTokens: 30,
          },
        }
      }

      if (providerCalls.length === 0) {
        providerCalls.push('model-1')
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 90,
            outputTokens: 0,
          },
        }
      }

      providerCalls.push('model-2')
      const contextItems = request.contextItems ?? []
      assert.ok(!contextItems.some((item) => item.kind === 'message' && /Prior conversation was compacted/.test(item.message.content)))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 2,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextManagement: {
      contextWindow: 200,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    tokenBudget: 200,
    tokenWarningThreshold: 0.4,
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 10,
    inputTokens: 111,
    outputTokens: 32,
  })
  assert.deepEqual(providerCalls, ['model-1', 'compact', 'model-2'])
  assert.equal(loadRecordsCount, 1)
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('agent loop continues the turn when auto-compact summary fails', async () => {
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
  ]
  const providerCalls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.cacheSource === 'compact'
      if (isCompactRequest) {
        providerCalls.push('compact')
        throw new Error('compact summarizer failed')
      }

      providerCalls.push('main')
      return {
        content: 'main response',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 'compact-failure-session', readFiles: new Set() },
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('latest request')

  assert.equal(response.content, 'main response')
  assert.deepEqual(providerCalls, ['compact', 'main'])
  assert.equal(records.filter((record) => record.type === 'compact_attempt_failed').length, 1)
  assert.equal(records.some((record) => record.type === 'compact_boundary'), false)
})

test('agent loop switches to fallback model after overload fallback trigger', async () => {
  resetCacheBreakDetection()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'previous-assistant',
    role: 'assistant',
    content: 'previous response',
    thinkingBlocks: [{
      type: 'thinking',
      thinking: 'previous thinking',
      signature: 'primary-signature',
    }],
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const source = 'agent:s1'
  recordPromptState({ system: 'system', toolsJson: '[]', model: 'primary-model' }, source)
  checkResponseForCacheBreak(10_000, 10_000, source)

  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage(request) {
      assert.equal(request.model, 'fallback-model')
      assert.equal(request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.thinkingBlocks && item.message.thinkingBlocks.length > 0,
      ), false)
      recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
      assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
      return {
        content: 'fallback response',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'primary-model',
    modelKey: 'primary',
    fallbackModel: {
      provider: fallbackProvider,
      model: 'fallback-model',
      modelKey: 'fallback',
      providerName: 'fallback',
    },
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')
  assert.equal(response.content, 'fallback response')
  assert.equal(loop.getActiveModel().modelKey, 'fallback')
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.model === 'fallback-model'))
})

test('agent loop retries primary model after fallback cooldown', async () => {
  resetCacheBreakDetection()
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const records: SessionRecord[] = []
    const cacheClears: Array<string | undefined> = []
    const contextBuilder = new class extends ContextBuilder {
      override clearCachedSections(key?: string): void {
        cacheClears.push(key)
        super.clearCachedSections(key)
      }
    }()
    let primaryCalls = 0
    let fallbackCalls = 0

    const primaryProvider: ModelProvider = {
      name: 'primary',
      async createMessage(request) {
        primaryCalls += 1
        assert.equal(request.model, 'primary-model')
        if (primaryCalls === 1) {
          throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
        }
        recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
        assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
        return {
          content: 'primary response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const fallbackProvider: ModelProvider = {
      name: 'fallback',
      async createMessage(request) {
        fallbackCalls += 1
        assert.equal(request.model, 'fallback-model')
        recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
        assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
        return {
          content: 'fallback response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const loop = new AgentLoop({
      provider: primaryProvider,
      model: 'primary-model',
      modelKey: 'primary',
      fallbackModel: {
        provider: fallbackProvider,
        model: 'fallback-model',
        modelKey: 'fallback',
        providerName: 'fallback',
      },
      tools: [],
      contextBuilder,
      toolRunner: runner,
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    const first = await loop.run('hello')
    assert.equal(first.content, 'fallback response')
    assert.equal(loop.getActiveModel().modelKey, 'fallback')

    now += (5 * 60 * 1000) - 1
    const second = await loop.run('still there?')
    assert.equal(second.content, 'fallback response')
    assert.equal(loop.getActiveModel().modelKey, 'fallback')

    now += 1
    const third = await loop.run('try again')
    assert.equal(third.content, 'primary response')
    assert.equal(loop.getActiveModel().modelKey, 'primary')
    assert.equal(primaryCalls, 2)
    assert.equal(fallbackCalls, 2)
    assert.ok(cacheClears.length >= 2)
    assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.model === 'primary-model'))
  } finally {
    Date.now = originalNow
  }
})

test('agent loop returns to fallback when primary cooldown retry is still overloaded', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const records: SessionRecord[] = []
    const calls: string[] = []
    const primaryProvider: ModelProvider = {
      name: 'primary',
      async createMessage() {
        calls.push('primary')
        throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
      },
    }
    const fallbackProvider: ModelProvider = {
      name: 'fallback',
      async createMessage() {
        calls.push('fallback')
        return {
          content: 'fallback response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const loop = new AgentLoop({
      provider: primaryProvider,
      model: 'primary-model',
      modelKey: 'primary',
      fallbackModel: {
        provider: fallbackProvider,
        model: 'fallback-model',
        modelKey: 'fallback',
        providerName: 'fallback',
      },
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await loop.run('hello')
    now += 5 * 60 * 1000
    const response = await loop.run('try primary')

    assert.equal(response.content, 'fallback response')
    assert.deepEqual(calls, ['primary', 'fallback', 'primary', 'fallback'])
    assert.equal(loop.getActiveModel().modelKey, 'fallback')
  } finally {
    Date.now = originalNow
  }
})

test('agent loop uses last response usage, not cumulative usage, for auto-compact checks', async () => {
  const records: SessionRecord[] = []
  const providerCalls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      assert.equal(isCompactRequest, false)

      if (providerCalls.length === 0) {
        assert.equal(request.cacheSource, 'agent:s1')
        providerCalls.push('model-1')
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 80,
            outputTokens: 30,
          },
        }
      }

      providerCalls.push('model-2')
      assert.equal(request.cacheSource, 'agent:s1')
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextManagement: {
      contextWindow: 200,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 20,
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run('hello')

  assert.equal(response.content, 'done')
  assert.deepEqual(providerCalls, ['model-1', 'model-2'])
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 0)
})

