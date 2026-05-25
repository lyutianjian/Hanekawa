import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import {
  ANTHROPIC_CACHE_CONTROL_LIMIT,
  buildAnthropicMessages,
  buildAnthropicPayload,
  collectCacheControlTelemetry,
} from '../src/config/providers.js'
import { resetCacheTTLEvaluation, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/harness/cacheControl.js'
import type { ModelContextItem, ModelRequest, Tool } from '../src/harness/types.js'

const createdAt = '2026-05-24T00:00:00.000Z'

const tools: Tool[] = [
  {
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ filePath: z.string() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'Grep',
    description: 'Search files',
    inputSchema: z.object({ pattern: z.string() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  },
]

const transcript: ModelContextItem[] = [
  {
    kind: 'message',
    message: {
      id: 'u1',
      role: 'user',
      content: 'Find the cache control code.',
      createdAt,
    },
  },
  {
    kind: 'message',
    message: {
      id: 'a1',
      role: 'assistant',
      content: 'I will inspect the provider payload builder.',
      createdAt,
    },
  },
  {
    kind: 'tool_use',
    id: 'call-1',
    tool: 'Grep',
    input: { pattern: 'cache_control' },
  },
  {
    kind: 'tool_result',
    toolUseId: 'call-1',
    tool: 'Grep',
    ok: true,
    content: 'src/config/providers/anthropicPayload.ts: cache_control',
  },
  {
    kind: 'message',
    message: {
      id: 'u2',
      role: 'user',
      content: 'Now summarize what keeps the cache warm.',
      createdAt,
    },
  },
]

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    cacheSource: 'agent:test',
    model: 'claude-sonnet-test',
    messages: [],
    contextItems: transcript,
    systemBlocks: [
      'static identity',
      'static instructions',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'dynamic session state',
    ],
    tools,
    cacheRuntime: {
      env: {
        MYAGENT_PROMPT_CACHE_1H: '0',
      },
    },
    ...overrides,
  }
}

function assertCacheControlDistribution(
  modelRequest: ModelRequest,
  expected: { system: number; tools: number; messages: number; other?: number },
) {
  resetCacheTTLEvaluation()

  const payload = buildAnthropicPayload(modelRequest, undefined, true)
  const telemetry = collectCacheControlTelemetry(payload)

  assert.ok(
    telemetry.total <= ANTHROPIC_CACHE_CONTROL_LIMIT,
    `expected no more than ${ANTHROPIC_CACHE_CONTROL_LIMIT} cache_control markers, got ${telemetry.total}: ${telemetry.paths.join(', ')}`,
  )
  assert.deepEqual(telemetry.byLocation, {
    system: expected.system,
    tools: expected.tools,
    messages: expected.messages,
    other: expected.other ?? 0,
  })
  assert.equal(telemetry.total, expected.system + expected.tools + expected.messages + (expected.other ?? 0))
}

test('buildAnthropicPayload keeps cache_control markers within Anthropic limit for a full request', () => {
  assertCacheControlDistribution(request(), {
    system: 1,
    tools: 1,
    messages: 1,
  })
})

test('buildAnthropicPayload cache_control distribution follows available request sections', () => {
  assertCacheControlDistribution(request({ systemBlocks: undefined, system: undefined }), {
    system: 0,
    tools: 1,
    messages: 1,
  })

  assertCacheControlDistribution(request({ tools: [] }), {
    system: 1,
    tools: 0,
    messages: 1,
  })

  assertCacheControlDistribution(request({
    contextItems: [],
    messages: [],
    tools: [],
  }), {
    system: 1,
    tools: 0,
    messages: 1,
  })
})

test('buildAnthropicMessages keeps injected subagent summary after Agent tool_result valid', () => {
  const messages = buildAnthropicMessages(request({
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'Run verification.',
          createdAt,
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will run a verification sub-agent.',
          createdAt,
        },
      },
      {
        kind: 'tool_use',
        id: 'agent-call-1',
        tool: 'Agent',
        input: { task: 'verify', subagent_type: 'verification' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'agent-call-1',
        tool: 'Agent',
        ok: true,
        content: 'Checked behavior.\nVERDICT: PASS',
      },
      {
        kind: 'message',
        message: {
          id: 'subagent-summary-1',
          role: 'assistant',
          content: '<subagent-summary type="verification" verdict="PASS" />',
          createdAt,
        },
      },
      {
        kind: 'message',
        message: {
          id: 'u2',
          role: 'user',
          content: 'Thanks.',
          createdAt,
        },
      },
    ],
  }))

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'agent-call-1',
      content: 'Checked behavior.\nVERDICT: PASS',
      is_error: false,
    }],
  })
  assert.deepEqual(messages[3], {
    role: 'assistant',
    content: [{ type: 'text', text: '<subagent-summary type="verification" verdict="PASS" />' }],
  })
})
