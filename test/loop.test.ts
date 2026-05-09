import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { ModelProvider, ModelRequest, SessionRecord, Tool } from '../src/harness/types.js'

test('agent loop appends user and assistant messages', async () => {
  const records: SessionRecord[] = []
  let seenMaxTokens: number | undefined
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      seenMaxTokens = request.maxTokens
      return { content: 'hello back', toolCalls: [] }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    maxTokens: 1234,
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    loadRecords: async () => records,
    appendRecord: async (record) => { records.push(record) },
  })
  const response = await loop.run('hello')
  assert.equal(response, 'hello back')
  assert.equal(seenMaxTokens, 1234)
  assert.equal(records.filter((record) => record.type === 'message').length, 2)
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
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.role === 'assistant' && item.message.content === 'I will use the echo tool.'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1' && item.content === '{"value":"hello"}'))
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: {},
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
    loadRecords: async () => records,
    appendRecord: async (record) => { records.push(record) },
  })
  const response = await loop.run('hello')
  assert.equal(response, 'done')
  assert.equal(seenRequests.length, 2)
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'I will use the echo tool.'))
  assert.ok(records.some((record) => record.type === 'tool_use'))
  assert.ok(records.some((record) => record.type === 'tool_result'))
  assert.equal(records.filter((record) => record.type === 'message' && record.role === 'tool').length, 0)
})
