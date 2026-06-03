import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider, streamWithTimeout } from '../src/config/providers/anthropicProvider.js'

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

  finish(text = ''): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
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

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(assertion(), true)
}
