import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate } from '../src/harness/permissions.js'
import type { ModelProvider, ModelRequest, ModelResponse, Tool, SessionRecord } from '../src/harness/types.js'

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

function createMockProvider(): ModelProvider & { requests: ModelRequest[] } {
  const provider: ModelProvider & { requests: ModelRequest[] } = {
    name: 'mock',
    requests: [],
    async createMessage(request: ModelRequest): Promise<ModelResponse> {
      provider.requests.push(request)
      if (request.retry?.signal?.aborted) {
        throw abortError()
      }
      if (request.retry?.signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10)
          request.retry!.signal!.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(abortError())
          })
        })
      }
      return { content: 'response', toolCalls: [], usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 } }
    },
  }
  return provider
}

function noopPermission(): Promise<boolean> {
  return Promise.resolve(true)
}

describe('AgentLoop abort', () => {
  let provider: ReturnType<typeof createMockProvider>
  let tools: Tool[]
  let loop: AgentLoop

  beforeEach(async () => {
    provider = createMockProvider()
    tools = []
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner(tools, permissionGate, {
      onRecord: async () => {},
    })
    const contextBuilder = new ContextBuilder()
    const records: SessionRecord[] = []
    loop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools,
      contextBuilder,
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      loadRecords: async () => records,
      appendRecord: async (r) => { records.push(r) },
    })
  })

  it('passes AbortSignal to provider.createMessage', async () => {
    const controller = new AbortController()
    const runPromise = loop.run('test input', controller.signal)

    // Small delay then check
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()

    try {
      await runPromise
      assert.fail('Expected AbortError')
    } catch (err: unknown) {
      const e = err as { name?: string }
      assert.equal(e.name, 'AbortError')
    }

    assert(provider.requests.length >= 1)
    assert(provider.requests[0].retry?.signal instanceof AbortSignal)
  })

  it('rejects immediately when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    try {
      await loop.run('test input', controller.signal)
      assert.fail('Expected AbortError')
    } catch (err: unknown) {
      const e = err as { name?: string }
      assert.equal(e.name, 'AbortError')
    }
  })

  it('works without signal (backward compatible)', async () => {
    const result = await loop.run('test input')
    assert.equal(result.content, 'response')
    assert.equal(provider.requests.length, 1)
    assert.equal(provider.requests[0].retry?.signal, undefined)
  })
})
