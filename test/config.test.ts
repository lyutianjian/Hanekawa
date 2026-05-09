import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfigService } from '../src/config/service.js'
import {
  AnthropicProvider,
  OpenAIProvider,
  ProviderRegistry,
  buildAnthropicMessages,
  buildAnthropicPayload,
  buildAnthropicTools,
  buildOpenAIMessages,
  buildOpenAIPayload,
  buildOpenAITools,
  createProvider,
} from '../src/config/providers.js'
import { getBuiltinTools } from '../src/tools/index.js'
import type { ModelRequest } from '../src/harness/types.js'

test('ConfigService loads defaults and saves config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    const config = service.get()
    assert.ok(config.models)
    assert.ok(config.agent)
    assert.equal(config.defaultModel, 'anthropic')

    service.addModel('test', { provider: 'anthropic', model: 'test-model' })
    assert.ok(service.getModel('test'))
    assert.equal(service.getModel('test')?.model, 'test-model')

    service.setDefaultModel('test')
    assert.equal(service.getDefaultModel()?.model, 'test-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ProviderRegistry registers and retrieves providers', () => {
  const registry = new ProviderRegistry()
  assert.ok(!registry.has('test'))
  assert.equal(registry.get('test'), undefined)

  const provider = createProvider({ provider: 'anthropic', model: 'claude-3' })
  if (provider) {
    registry.register(provider)
    assert.ok(registry.has('anthropic'))
    assert.equal(registry.get('anthropic')?.name, 'anthropic')
    assert.deepEqual(registry.list(), ['anthropic'])
  }
})

test('createProvider selects adapter from provider field', () => {
  const anthropic = createProvider({ provider: 'anthropic', model: 'claude-3', apiKey: 'test-key' })
  const openai = createProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' })

  assert.ok(anthropic instanceof AnthropicProvider)
  assert.ok(openai instanceof OpenAIProvider)
})

test('buildAnthropicMessages includes tool use and tool results', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    system: 'system text',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'readFile',
        input: { filePath: 'a.txt' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'readFile',
        ok: true,
        content: 'file body',
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [{
    type: 'tool_use',
    id: 'call-1',
    name: 'readFile',
    input: { filePath: 'a.txt' },
  }])
  assert.equal(messages[2]?.role, 'user')
  assert.deepEqual(messages[2]?.content, [{
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'file body',
    is_error: false,
  }])
})

test('buildOpenAIMessages includes tool call history and tool results', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'grep',
        input: { pattern: 'hello' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'grep',
        ok: true,
        content: 'a.txt:1: hello',
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
  assert.equal(messages[2]?.role, 'tool')
  assert.equal((messages[2] as { tool_call_id: string }).tool_call_id, 'call-1')
})

test('buildAnthropicPayload omits tool fields for plain-text requests', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: '你是谁',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
  assert.ok(!('tool_choice' in payload))
  assert.ok(!('system' in payload))
})

test('buildOpenAIPayload omits tools for plain-text requests', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: '你是谁',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildOpenAIPayload(request) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
})

test('buildOpenAITools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'readFile')
  assert.ok(readFileTool)

  const tools = buildOpenAITools([readFileTool])
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0]?.function.parameters, {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
    },
    required: ['filePath'],
    additionalProperties: false,
  })
})

test('buildAnthropicTools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'readFile')
  assert.ok(readFileTool)

  const tools = buildAnthropicTools([readFileTool])
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0]?.input_schema, {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
    },
    required: ['filePath'],
    additionalProperties: false,
  })
})

test('buildAnthropicMessages merges assistant text with following tool use', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'read the file',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will read it now.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'readFile',
        input: { filePath: 'src/config/providers.ts' },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [
    'I will read it now.',
    {
      type: 'tool_use',
      id: 'call-1',
      name: 'readFile',
      input: { filePath: 'src/config/providers.ts' },
    },
  ])
})

test('buildOpenAIMessages merges assistant text with following tool call', () => {
  const request: ModelRequest = {
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'search for hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will search the codebase.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'grep',
        input: { pattern: 'hello' },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.equal((messages[1] as { content: string }).content, 'I will search the codebase.')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
})
