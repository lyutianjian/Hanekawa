import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { AnthropicProvider, resetRejectedPromptCaching, streamWithTimeout } from '../src/config/providers/anthropicProvider.js'
import { collectCacheControlTelemetry } from '../src/config/providers/cacheControlTelemetry.js'
import { resetCacheBreakDetection } from '../src/harness/cacheBreakDetection.js'
import type { ModelRequest } from '../src/harness/types.js'

const cacheEnvironment = new Map(
  ['MYAGENT_DISABLE_PROMPT_CACHING', 'MYAGENT_DEBUG_PROVIDER'].map((key) => [key, process.env[key]]),
)

beforeEach(() => {
  resetCacheBreakDetection()
  resetRejectedPromptCaching()
  for (const key of cacheEnvironment.keys()) delete process.env[key]
})

afterEach(() => {
  for (const [key, previous] of cacheEnvironment) {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

type Message = Awaited<ReturnType<typeof streamWithTimeout>>

class FakeAnthropicStream {
  aborted = false
  private listeners = new Set<(...args: unknown[]) => void>()
  private resolveFinal!: (message: Message) => void
  private rejectFinal!: (error: Error) => void
  private final = new Promise<Message>((resolve, reject) => {
    this.resolveFinal = resolve
    this.rejectFinal = reject
  })

  finalMessage(): Promise<Message> {
    return this.final
  }

  abort(): void {
    this.aborted = true
  }

  on(event: 'streamEvent', listener: (...args: unknown[]) => void): this {
    if (event === 'streamEvent') this.listeners.add(listener)
    return this
  }

  off(event: 'streamEvent', listener: (...args: unknown[]) => void): this {
    if (event === 'streamEvent') this.listeners.delete(listener)
    return this
  }

  emitStreamEvent(): void {
    for (const listener of this.listeners) listener({ type: 'ping' })
  }

  emitTextDelta(text: string): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      })
    }
  }

  emitThinkingStart(index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking' },
      })
    }
  }

  emitThinkingDelta(thinking: string, index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'thinking_delta',
          thinking,
        },
      })
    }
  }

  emitThinkingStop(index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_stop',
        index,
      })
    }
  }

  finish(text = '', usage: Partial<Message['usage']> = { input_tokens: 1, output_tokens: 1 }): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    } as unknown as Message)
  }

  finishWithContent(content: Array<Record<string, unknown>>): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content,
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Message)
  }

  fail(error: Error): void {
    this.rejectFinal(error)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

test('Anthropic stream timeout is reset by stream events', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const responsePromise = streamWithTimeout(stream, undefined, 100)
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(stream.aborted, false)

    stream.emitStreamEvent()
    mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(stream.aborted, false)

    stream.finish()
    const response = await responsePromise
    assert.equal(response.id, 'msg_1')
    assert.equal(stream.aborted, false)
    assert.equal(stream.listenerCount(), 0)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream emits text deltas through callback', async () => {
  const stream = new FakeAnthropicStream()
  const deltas: string[] = []
  const responsePromise = streamWithTimeout(
    stream,
    undefined,
    100,
    (delta) => deltas.push(delta),
  )

  stream.emitTextDelta('hello ')
  stream.emitTextDelta('world')
  stream.finish()

  await responsePromise
  assert.deepEqual(deltas, ['hello ', 'world'])
  assert.equal(stream.listenerCount(), 0)
})

test('Anthropic stream emits thinking events and resets idle timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const events: string[] = []
    const responsePromise = streamWithTimeout(
      stream,
      undefined,
      100,
      undefined,
      (event) => events.push(event.type),
      0,
    )
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(99)
    stream.emitThinkingStart()
    stream.emitThinkingDelta('still thinking')
    mock.timers.tick(99)
    await Promise.resolve()

    assert.equal(settled, false)
    assert.equal(stream.aborted, false)
    stream.emitThinkingStop()
    stream.finish()

    await responsePromise
    assert.deepEqual(events, ['thinking_start', 'thinking_delta', 'thinking_stop'])
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream idle warning does not abort the stream', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const events: string[] = []
    const responsePromise = streamWithTimeout(
      stream,
      undefined,
      500,
      undefined,
      (event) => events.push(event.type),
      100,
    )
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(100)
    await Promise.resolve()
    assert.deepEqual(events, ['idle_warning'])
    assert.equal(stream.aborted, false)
    assert.equal(settled, false)

    stream.finish('after warning')
    const response = await responsePromise
    assert.equal(response.id, 'msg_1')
    assert.equal(stream.aborted, false)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream timeout aborts after an idle interval', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const responsePromise = streamWithTimeout(stream, undefined, 100)
    const rejection = assert.rejects(responsePromise, /Stream idle timeout/)

    mock.timers.tick(100)

    await rejection
    assert.equal(stream.aborted, true)
    assert.equal(stream.listenerCount(), 0)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic provider retries streaming after stream idle timeout', async () => {
  const streams = [new FakeAnthropicStream(), new FakeAnthropicStream()]
  let streamCalls = 0
  let createCalls = 0
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        const stream = streams[streamCalls]
        streamCalls++
        if (!stream) throw new Error('unexpected extra stream call')
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1 },
  })

  streams[0]!.fail(new Error('Stream idle timeout'))
  await waitFor(() => streamCalls === 2)

  streams[1]!.finish('stream retry response')
  const response = await responsePromise
  assert.equal(streamCalls, 2)
  assert.equal(createCalls, 0)
  assert.equal(response.content, 'stream retry response')
})

test('Anthropic provider does not retry user aborts as idle timeouts', async () => {
  const stream = new FakeAnthropicStream()
  let streamCalls = 0
  let createCalls = 0
  const controller = new AbortController()
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        streamCalls++
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1, signal: controller.signal },
  })
  controller.abort()

  await assert.rejects(responsePromise, /aborted/i)
  assert.equal(stream.aborted, true)
  assert.equal(streamCalls, 1)
  assert.equal(createCalls, 0)
})

test('Anthropic provider keeps existing retry behavior for transient stream errors', async () => {
  const streams = [new FakeAnthropicStream(), new FakeAnthropicStream()]
  let streamCalls = 0
  let createCalls = 0
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        const stream = streams[streamCalls]
        streamCalls++
        if (!stream) throw new Error('unexpected extra stream call')
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1 },
  })

  streams[0]!.fail(new Error('stream ended unexpectedly'))
  await waitFor(() => streamCalls === 2)

  streams[1]!.finish('transient retry response')
  const response = await responsePromise
  assert.equal(streamCalls, 2)
  assert.equal(createCalls, 0)
  assert.equal(response.content, 'transient retry response')
})

test('Anthropic provider preserves final thinking blocks in the model response', async () => {
  const stream = new FakeAnthropicStream()
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
      }
    }
  }).client = {
    messages: {
      stream: () => stream,
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 0 },
  })

  stream.finishWithContent([
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' },
    { type: 'text', text: 'final answer' },
  ])

  const response = await responsePromise
  assert.equal(response.content, 'final answer')
  assert.deepEqual(response.thinkingBlocks, [{
    type: 'thinking',
    thinking: 'private reasoning',
    signature: 'sig-1',
  }])
})

function cacheRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-sonnet',
    system: 'Stable system instructions',
    messages: [{ id: 'user-1', role: 'user', content: 'Read the file', createdAt: '2026-09-06T00:00:00Z' }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      inputSchema: z.object({ path: z.string() }),
      riskLevel: 'safe',
      execute: async () => ({ ok: true, content: '' }),
    }],
    cacheRuntime: { settings: { cache: { ttl1h: false } } },
    cacheSource: 'agent:cache-test',
    retry: { maxRetries: 0 },
    ...overrides,
  }
}

function captureRequests(
  provider: AnthropicProvider,
  respond: (index: number) => Partial<Message['usage']> | Error,
) {
  const requests: Array<{ payload: Record<string, unknown>; options?: { headers: Record<string, string> } }> = []
  ;(provider as unknown as {
    client: { messages: { stream: (payload: Record<string, unknown>, options?: { headers: Record<string, string> }) => FakeAnthropicStream } }
  }).client = {
    messages: {
      stream: (payload, options) => {
        requests.push({ payload, options })
        const stream = new FakeAnthropicStream()
        const result = respond(requests.length - 1)
        if (result instanceof Error) stream.fail(result)
        else stream.finish('answer', result)
        return stream
      },
    },
  }
  return requests
}

test('ordinary caching has the same defaults on official and compatible endpoints', async () => {
  for (const baseUrl of ['https://api.anthropic.com', 'https://proxy.example/v1']) {
    const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl })
    const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5_000 }))
    await provider.createMessage(cacheRequest())

    assert.deepEqual(collectCacheControlTelemetry(requests[0]!.payload).byLocation, {
      system: 1, tools: 1, messages: 1, other: 0,
    })
    assert.equal(requests[0]!.options, undefined)
    assert.equal('context_management' in requests[0]!.payload, false)
    assert.doesNotMatch(JSON.stringify(requests[0]!.payload), /cache_edits|cache_reference/)
  }
})

test('auto retries unsupported caching once and remembers it only for this endpoint and model', async () => {
  const config = { model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://rejecting-proxy.example/v1', longContext1m: true }
  const provider = new AnthropicProvider(config)
  const rejected = Object.assign(new Error('cache_control is not supported for this model'), { status: 400 })
  const requests = captureRequests(provider, (index) => index === 0 ? rejected : { input_tokens: 10, output_tokens: 1 })
  const request = cacheRequest({ cacheRuntime: { settings: { cache: { ttl1h: true } } } })

  assert.equal((await provider.createMessage(request)).content, 'answer')
  await provider.createMessage(request)
  await provider.createMessage({ ...request, model: 'other-model' })

  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0, 0, 3])
  for (const { payload, options } of requests) {
    assert.equal(options?.headers['anthropic-beta'], 'context-1m-2025-08-07')
    assert.deepEqual((payload.tools as Array<{ name: string }>).map((tool) => tool.name), ['Read'])
    assert.equal('context_management' in payload, false)
  }

  const otherEndpoint = new AnthropicProvider({ ...config, baseUrl: 'https://another-proxy.example/v1' })
  const otherRequests = captureRequests(otherEndpoint, () => ({ input_tokens: 10, output_tokens: 1 }))
  await otherEndpoint.createMessage(request)
  assert.equal(collectCacheControlTelemetry(otherRequests[0]!.payload).total, 3)

  // A provider is rebuilt per session, model switch, and subagent — the probe
  // must not be repeated (and re-fail) on every new instance.
  const rebuilt = new AnthropicProvider(config)
  const rebuiltRequests = captureRequests(rebuilt, () => ({ input_tokens: 10, output_tokens: 1 }))
  await rebuilt.createMessage(request)
  assert.deepEqual(rebuiltRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [0])
})

test('auto only records the rejection once the uncached retry succeeds', async () => {
  const config = { model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://echoing-proxy.example/v1' }
  // A proxy that echoes the request body reports an unrelated failure with
  // `cache_control` in the message; the uncached retry fails for the same reason.
  const unrelated = Object.assign(new Error('invalid request: {"cache_control":{"type":"ephemeral"}} is not supported here'), { status: 400 })
  const failing = new AnthropicProvider(config)
  const failingRequests = captureRequests(failing, () => unrelated)
  await assert.rejects(failing.createMessage(cacheRequest()), (error) => error === unrelated)
  assert.deepEqual(failingRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])

  const recovered = new AnthropicProvider(config)
  const recoveredRequests = captureRequests(recovered, () => ({ input_tokens: 10, output_tokens: 1 }))
  await recovered.createMessage(cacheRequest())
  assert.deepEqual(recoveredRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3])
})

test('auto handles a compatible endpoint rejecting an extra cache_control field with HTTP 422', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const rejected = Object.assign(new Error('messages.0.content.0.cache_control: Extra inputs are not permitted'), { status: 422 })
  const requests = captureRequests(provider, (index) => index === 0 ? rejected : { input_tokens: 10, output_tokens: 1 })

  await provider.createMessage(cacheRequest())
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])
})

test('auto does not retry a rejected uncached fallback', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key' })
  const rejected = Object.assign(new Error('cache_control is not supported'), { status: 400 })
  const requests = captureRequests(provider, () => rejected)

  await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])
})

test('auto preserves unrelated API errors and existing retry policy', async () => {
  for (const [status, message] of [
    [400, 'max_tokens is invalid'],
    [400, 'At most 4 cache_control blocks are allowed'],
    [400, 'Unsupported beta header: context-1m-2025-08-07'],
    [401, 'cache_control is not supported'],
    [429, 'cache_control is not supported'],
    [500, 'cache_control is not supported'],
  ] as const) {
    const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key' })
    const rejected = Object.assign(new Error(message), { status })
    const requests = captureRequests(provider, () => rejected)
    await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
    assert.equal(requests.length, 1, `${status}: ${message}`)
  }
})

test('explicit off and the global kill switch omit cache markers', async () => {
  const off = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'off' })
  const offRequests = captureRequests(off, () => ({ input_tokens: 10, output_tokens: 1 }))
  await off.createMessage(cacheRequest())
  assert.equal(collectCacheControlTelemetry(offRequests[0]!.payload).total, 0)

  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const on = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'on' })
  const onRequests = captureRequests(on, () => ({ input_tokens: 10, output_tokens: 1 }))
  await on.createMessage(cacheRequest())
  assert.equal(collectCacheControlTelemetry(onRequests[0]!.payload).total, 0)
})

test('explicit on reports unsupported caching instead of silently disabling it', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'on' })
  const rejected = Object.assign(new Error('Unknown parameter: cache_control'), { status: 400 })
  const requests = captureRequests(provider, () => rejected)

  await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
  assert.equal(requests.length, 1)
  assert.equal(collectCacheControlTelemetry(requests[0]!.payload).total, 3)
})

test('1h caching on a compatible endpoint does not add beta headers', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  await provider.createMessage(cacheRequest({ cacheRuntime: { settings: { cache: { ttl1h: true } } } }))

  const payload = requests[0]!.payload as { system: Array<{ cache_control: unknown }> }
  assert.deepEqual(payload.system[0]!.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(requests[0]!.options, undefined)
})

test('compatible endpoints report cache breaks without interpreting zero hits as unsupported caching', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const cacheReads = [0, 8_000, 0]
  const requests = captureRequests(provider, (index) => ({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: cacheReads[index] }))
  await provider.createMessage(cacheRequest())
  await provider.createMessage(cacheRequest())
  const result = await provider.createMessage(cacheRequest({ system: 'Changed system instructions' }))

  assert.equal(result.cacheBreak?.tokenDrop, 8_000)
  assert.ok(result.cacheBreak?.reasons.some((reason) => reason.startsWith('system_prompt_changed')))
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 3, 3])
})

test('missing cache usage does not report a false eviction or erase the previous baseline', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  captureRequests(provider, (index) => ({
    input_tokens: 20,
    output_tokens: 1,
    ...(index === 1 ? {} : { cache_read_input_tokens: index === 0 ? 8_000 : 0 }),
  }))
  await provider.createMessage(cacheRequest())
  const missing = await provider.createMessage(cacheRequest())
  const zero = await provider.createMessage(cacheRequest())

  assert.equal(missing.cacheBreak, undefined)
  assert.equal(zero.cacheBreak?.tokenDrop, 8_000)
  assert.deepEqual(zero.cacheBreak?.reasons, ['server_side'])
})

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(assertion(), true)
}
