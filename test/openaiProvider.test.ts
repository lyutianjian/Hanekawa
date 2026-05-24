import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { OpenAIProvider } from '../src/config/providers/openaiProvider.js'
import { resetCacheBreakDetection, type CacheBreakSource } from '../src/harness/cacheBreakDetection.js'
import type { ModelRequest, Tool } from '../src/harness/types.js'

interface FakeOpenAIResponse {
  id: string
  choices: Array<{
    finish_reason: string
    message: {
      content: string
      reasoning_content?: string
      tool_calls?: Array<{
        id: string
        function: {
          name: string
          arguments: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

function installFakeClient(
  provider: OpenAIProvider,
  create: (payload: unknown, options?: unknown) => Promise<FakeOpenAIResponse>,
): void {
  ;(provider as unknown as {
    client: {
      chat: {
        completions: {
          create: typeof create
        }
      }
    }
  }).client = {
    chat: {
      completions: {
        create,
      },
    },
  }
}

function openAIResponse(
  id: string,
  cachedTokens: number,
  promptTokens = cachedTokens + 1_000,
  reasoningContent?: string,
): FakeOpenAIResponse {
  return {
    id,
    choices: [{
      finish_reason: 'stop',
      message: {
        content: 'visible answer',
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 42,
      prompt_tokens_details: {
        cached_tokens: cachedTokens,
      },
    },
  }
}

function createTool(name: string, inputSchema: Tool['inputSchema']): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema,
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }
}

function baseRequest(source: CacheBreakSource): ModelRequest {
  return {
    cacheSource: source,
    model: 'gpt-test',
    system: 'system',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date('2026-05-24T00:00:00.000Z').toISOString(),
    }],
    retry: { maxRetries: 0 },
  }
}

test('OpenAI provider preserves reasoning_content and cached-token usage', async () => {
  const source = 'agent:openai-reasoning-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'deepseek-reasoner',
      apiKey: 'test-key',
    })
    installFakeClient(provider, async () => openAIResponse(
      'chatcmpl_reasoning',
      300,
      1_000,
      'private reasoning from provider',
    ))

    const response = await provider.createMessage({
      ...baseRequest(source),
      model: 'deepseek-reasoner',
    })

    assert.equal(response.content, 'visible answer')
    assert.equal(response.reasoningContent, 'private reasoning from provider')
    assert.deepEqual(response.usage, {
      inputTokens: 700,
      cacheReadInputTokens: 300,
      outputTokens: 42,
    })
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('OpenAI provider reports cache breaks with prompt-change reasons', async () => {
  const scenarios: Array<{
    name: string
    source: CacheBreakSource
    previous: ModelRequest
    current: ModelRequest
    expectedReason: RegExp
  }> = [
    {
      name: 'system',
      source: 'agent:openai-cache-system-test',
      previous: baseRequest('agent:openai-cache-system-test'),
      current: { ...baseRequest('agent:openai-cache-system-test'), system: 'changed system' },
      expectedReason: /^system_prompt_changed/,
    },
    {
      name: 'tools',
      source: 'agent:openai-cache-tools-test',
      previous: {
        ...baseRequest('agent:openai-cache-tools-test'),
        tools: [createTool('lookup', z.object({ query: z.string() }))],
      },
      current: {
        ...baseRequest('agent:openai-cache-tools-test'),
        tools: [createTool('lookup', z.object({ query: z.number() }))],
      },
      expectedReason: /^tool_schemas_changed$/,
    },
    {
      name: 'model',
      source: 'agent:openai-cache-model-test',
      previous: baseRequest('agent:openai-cache-model-test'),
      current: { ...baseRequest('agent:openai-cache-model-test'), model: 'gpt-other' },
      expectedReason: /^model_changed$/,
    },
  ]

  for (const scenario of scenarios) {
    resetCacheBreakDetection(scenario.source)
    try {
      let calls = 0
      const provider = new OpenAIProvider({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'test-key',
      })
      installFakeClient(provider, async () => {
        calls += 1
        return calls === 1
          ? openAIResponse(`chatcmpl_${scenario.name}_1`, 10_000, 11_000)
          : openAIResponse(`chatcmpl_${scenario.name}_2`, 100, 1_100)
      })

      const first = await provider.createMessage(scenario.previous)
      const second = await provider.createMessage(scenario.current)

      assert.equal(first.cacheBreak, undefined)
      assert.equal(second.cacheBreak?.source, scenario.source)
      assert.equal(second.cacheBreak?.tokenDrop, 9_900)
      assert.ok(
        second.cacheBreak?.reasons.some((reason) => scenario.expectedReason.test(reason)),
        `${scenario.name} cache break reasons: ${second.cacheBreak?.reasons.join(', ')}`,
      )
    } finally {
      resetCacheBreakDetection(scenario.source)
    }
  }
})
