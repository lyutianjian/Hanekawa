import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider, streamWithTimeout } from '../src/config/providers/anthropicProvider.js'

type Message = Awaited<ReturnType<typeof streamWithTimeout>>

class FakeAnthropicStream {
  aborted = false
  private listeners = new Set<(...args: unknown[]) => void>()
  private resolveFinal!: (message: Message) => void
  private final = new Promise<Message>((resolve) => {
    this.resolveFinal = resolve
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
        delta: {
          type: 'text_delta',
          text,
        },
      })
    }
  }

  finish(): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Message)
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

test('Anthropic provider falls back to a non-streaming request after stream idle timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    let createdPayload: Record<string, unknown> | undefined
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
        stream: () => stream,
        create: async (payload) => {
          createdPayload = payload
          return {
            id: 'msg_fallback',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'fallback response' }],
            model: 'claude-sonnet',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 3 },
          } as unknown as Message
        },
      },
    }

    const responsePromise = provider.createMessage({
      model: 'claude-sonnet',
      messages: [],
      tools: [],
      cacheSource: 'agent:test',
      retry: { maxRetries: 0 },
    })

    mock.timers.tick(90_000)

    const response = await responsePromise
    assert.equal(stream.aborted, true)
    assert.equal(response.content, 'fallback response')
    assert.equal(createdPayload?.stream, false)
  } finally {
    mock.timers.reset()
  }
})
