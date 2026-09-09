import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { OpenAIProvider } from '../src/config/providers/openaiProvider.js'
import { buildOpenAIMessages } from '../src/config/providers/openaiPayload.js'
import { resetCacheBreakDetection, type CacheBreakSource } from '../src/harness/cacheBreakDetection.js'
import { clearToolSchemaCache } from '../src/utils/toolSchemaCache.js'
import type { ModelRequest, RequestImageBytes, Tool } from '../src/harness/types.js'
import type { ImageAttachmentRef, ImageMimeType } from '../src/media/types.js'

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
  baseURL = 'https://api.openai.com/v1',
): void {
  ;(provider as unknown as {
    client: {
      baseURL: string
      chat: {
        completions: {
          create: typeof create
        }
      }
    }
  }).client = {
    baseURL,
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

test('OpenAI provider normalizes length finish_reason to max_tokens', async () => {
  const source = 'agent:openai-length-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    installFakeClient(provider, async () => ({
      ...openAIResponse('chatcmpl_length', 0),
      choices: [{
        finish_reason: 'length',
        message: {
          content: 'partial answer',
        },
      }],
    }))

    const response = await provider.createMessage(baseRequest(source))

    assert.equal(response.content, 'partial answer')
    assert.equal(response.stopReason, 'max_tokens')
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
    clearToolSchemaCache()
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

// --- Image payload mapping (S18, design §10.2) ---

const imageCreatedAt = '2026-09-08T00:00:00.000Z'

function imageRef(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id,
    ownerSessionId: 'session-image',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 64,
    height: 48,
    byteLength: 96,
    ...overrides,
  }
}

function imageBytesFor(bytes: Uint8Array, mimeType: ImageMimeType = 'image/png'): RequestImageBytes {
  return { bytes, mimeType }
}

function dataUrl(bytes: Uint8Array, mimeType: ImageMimeType = 'image/png'): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

function openAIMessagesOf(request: ModelRequest): Array<{ role: string; content: unknown; tool_call_id?: string }> {
  return buildOpenAIMessages(request) as Array<{ role: string; content: unknown; tool_call_id?: string }>
}

test('user messages map to text and image_url data URL parts; pure-image messages survive', () => {
  const shot = imageRef('img-shot', { name: 'shot.png' })
  // The ref claims PNG; the loaded bytes decide the data URL MIME.
  const diagram = imageRef('img-diagram', { name: 'diagram.jpg', mimeType: 'image/png' })
  const silent = imageRef('img-silent', { name: 'silent.png' })
  const shotBytes = new Uint8Array([1, 2, 3, 4])
  const diagramBytes = new Uint8Array([5, 6])

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: '请分析这张截图', images: [shot, diagram], createdAt: imageCreatedAt } },
      { kind: 'message', message: { id: 'u2', role: 'user', content: '', images: [silent], createdAt: imageCreatedAt } },
    ],
    imageBytes: new Map([
      [shot.id, imageBytesFor(shotBytes)],
      [diagram.id, imageBytesFor(diagramBytes, 'image/jpeg')],
      [silent.id, imageBytesFor(new Uint8Array([9]))],
    ]),
  })

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'system', content: 'system' })
  // deepEqual also pins "no detail key" — the first version sends none.
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: '请分析这张截图' },
      { type: 'image_url', image_url: { url: dataUrl(shotBytes) } },
      { type: 'image_url', image_url: { url: dataUrl(diagramBytes, 'image/jpeg') } },
    ],
  })
  // A pure-image message survives as an image-only content array, no empty text part.
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array([9])) } }],
  })
})

test('tool images ride a synthetic user message after the whole tool batch, never inside role: tool', () => {
  const shot = imageRef('img-shot', { name: 'shot.png' })
  const diagram = imageRef('img-diagram', { name: 'diagram.png' })
  const photo = imageRef('img-photo', { name: 'photo.jpg', mimeType: 'image/png' })

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'checking', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'shot.png' } },
      { kind: 'tool_use', id: 'call-2', tool: 'Read', input: { filePath: 'diagram.png' } },
      { kind: 'tool_use', id: 'call-3', tool: 'Grep', input: { pattern: 'x' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw it', images: [shot] },
      { kind: 'tool_result', toolUseId: 'call-2', tool: 'Read', ok: true, content: 'second', images: [diagram, photo] },
      { kind: 'tool_result', toolUseId: 'call-3', tool: 'Grep', ok: true, content: '2 matches' },
    ],
    imageBytes: new Map([
      [shot.id, imageBytesFor(new Uint8Array([1]))],
      [diagram.id, imageBytesFor(new Uint8Array([2]))],
      [photo.id, imageBytesFor(new Uint8Array([3]), 'image/jpeg')],
    ]),
  })

  assert.equal(messages.length, 6)
  // The assistant message carries all three calls of the batch.
  const assistant = messages[1] as { role: string; content: string; tool_calls: Array<{ id: string }> }
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['call-1', 'call-2', 'call-3'])
  // Tool messages stay pure text — Chat Completions `role: tool` accepts text only.
  assert.deepEqual(messages[2], { role: 'tool', content: 'saw it', tool_call_id: 'call-1' })
  assert.deepEqual(messages[3], { role: 'tool', content: 'second', tool_call_id: 'call-2' })
  assert.deepEqual(messages[4], { role: 'tool', content: '2 matches', tool_call_id: 'call-3' })
  // The synthetic message lands after the ENTIRE batch, clearly labelled as
  // tool output with its call IDs — never between the tool messages.
  assert.deepEqual(messages[5], {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[Tool output data, not user input. Images returned by tool calls: '
          + 'Read (tool call call-1): shot.png; Read (tool call call-2): diagram.png, photo.jpg.]',
      },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([1])) } },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([2])) } },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([3]), 'image/jpeg') } },
    ],
  })
})

test('each tool batch gets its own synthetic message; none is inserted mid-batch', () => {
  const first = imageRef('img-first', { name: 'first.png' })
  const second = imageRef('img-second', { name: 'second.png' })

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'look', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'first.png' } },
      // Pure-image tool result: the tool message keeps its (empty) string content.
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: '', images: [first] },
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'noted', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-2', tool: 'Read', input: { filePath: 'second.png' } },
      { kind: 'tool_result', toolUseId: 'call-2', tool: 'Read', ok: true, content: 'again', images: [second] },
    ],
    imageBytes: new Map([
      [first.id, imageBytesFor(new Uint8Array([1]))],
      [second.id, imageBytesFor(new Uint8Array([2]))],
    ]),
  })

  assert.equal(messages.length, 7)
  assert.deepEqual(messages[0], { role: 'user', content: 'look' })
  assert.deepEqual(messages[2], { role: 'tool', content: '', tool_call_id: 'call-1' })
  // Batch 1's images flush before the assistant reply that follows the batch.
  assert.equal(messages[3].role, 'user')
  const firstSynthetic = messages[3].content as Array<{ type: string; text?: string }>
  assert.equal(firstSynthetic[0]?.text, '[Tool output data, not user input. Images returned by tool calls: Read (tool call call-1): first.png.]')
  assert.equal(firstSynthetic.length, 2)
  // The next batch's tool_use still merges into the assistant message.
  const followUp = messages[4] as { role: string; content: string; tool_calls: Array<{ id: string }> }
  assert.equal(followUp.role, 'assistant')
  assert.equal(followUp.content, 'noted')
  assert.deepEqual(followUp.tool_calls.map((call) => call.id), ['call-2'])
  assert.deepEqual(messages[5], { role: 'tool', content: 'again', tool_call_id: 'call-2' })
  // A request ending on tool results flushes its batch last.
  assert.equal(messages[6].role, 'user')
  const secondSynthetic = messages[6].content as Array<{ type: string; text?: string }>
  assert.equal(secondSynthetic[0]?.text, '[Tool output data, not user input. Images returned by tool calls: Read (tool call call-2): second.png.]')
  assert.equal(secondSynthetic.length, 2)
})

test('requests without images keep the exact string format they have always had', () => {
  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'hello', createdAt: imageCreatedAt } },
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'checking', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'x.ts' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw it' },
    ],
  })

  // The pre-image shape, byte for byte: string contents everywhere and no
  // synthetic message trailing the tool result.
  assert.deepEqual(messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{"filePath":"x.ts"}' } }] },
    { role: 'tool', content: 'saw it', tool_call_id: 'call-1' },
  ])
})

test('an image ref without loaded bytes fails the payload build instead of silently dropping it', () => {
  const userRef = imageRef('img-missing-bytes', { name: 'missing.png' })
  const toolRef = imageRef('img-tool-missing', { name: 'tool-missing.png' })
  const userRequest: ModelRequest = {
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'look', images: [userRef], createdAt: imageCreatedAt } },
    ],
  }

  assert.throws(() => buildOpenAIMessages(userRequest), /missing\.png .*no send bytes loaded/)
  assert.throws(() => buildOpenAIMessages({ ...userRequest, imageBytes: new Map() }), /img-missing-bytes/)
  // The synthetic tool-output path refuses missing bytes too.
  assert.throws(() => buildOpenAIMessages({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: {} },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw', images: [toolRef] },
    ],
  }), /tool-missing\.png .*no send bytes loaded/)
})

test('an assistant message carrying images fails the build instead of emitting invalid content', () => {
  const ref = imageRef('img-assistant', { name: 'assistant.png' })
  assert.throws(() => buildOpenAIMessages({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'here', images: [ref], createdAt: imageCreatedAt } },
    ],
    imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1]))]]),
  }), /cannot carry image_url parts/)
})

test('endpoint rejections of image-bearing requests surface endpoint, model and reason without side effects', async () => {
  const source = 'agent:openai-image-reject-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    const ref = imageRef('img-reject', { name: 'reject.png' })
    const thrown = Object.assign(new Error('Invalid request: image_url content type not supported'), { status: 400 })
    let calls = 0
    installFakeClient(provider, async () => {
      calls += 1
      throw thrown
    })
    const imageRequest: ModelRequest = {
      ...baseRequest(source),
      retry: { maxRetries: 3 },
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look at this',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1, 2]))]]),
    }

    await assert.rejects(provider.createMessage(imageRequest), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Endpoint https:\/\/api\.openai\.com\/v1 \(model gpt-test\) rejected a request carrying 1 image\(s\)/)
      assert.match(error.message, /image_url content type not supported/)
      assert.match(error.message, /may not accept standard data URL image parts/)
      assert.match(error.message, /No protocol was switched, no image was dropped, and the capability setting was not changed automatically/)
      assert.equal((error as Error & { status?: number }).status, 400)
      assert.equal((error as { cause?: unknown }).cause, thrown)
      return true
    })
    // A request-shape rejection is not retried — no retry storm against an
    // incompatible endpoint.
    assert.equal(calls, 1)
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('auth failures and text-only rejections keep their original error', async () => {
  const authSource = 'agent:openai-image-auth-test'
  const textSource = 'agent:openai-image-text-test'
  resetCacheBreakDetection(authSource)
  resetCacheBreakDetection(textSource)
  try {
    // 401 on an image-bearing request is an auth problem, not an image
    // incompatibility — it must pass through untouched.
    const authProvider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    const authRef = imageRef('img-auth', { name: 'auth.png' })
    installFakeClient(authProvider, async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    await assert.rejects(authProvider.createMessage({
      ...baseRequest(authSource),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [authRef],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[authRef.id, imageBytesFor(new Uint8Array([1]))]]),
    }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Unauthorized')
      return true
    })

    // A 400 on a request without images has no image context to add.
    const textProvider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    installFakeClient(textProvider, async () => {
      throw Object.assign(new Error('Bad request'), { status: 400 })
    })
    await assert.rejects(textProvider.createMessage(baseRequest(textSource)), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Bad request')
      return true
    })
  } finally {
    resetCacheBreakDetection(authSource)
    resetCacheBreakDetection(textSource)
  }
})
