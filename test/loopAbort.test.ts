import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate } from '../src/harness/permissions.js'
import type { RecordStream } from '../src/harness/recordStream.js'
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

function recordStreamFor(records: SessionRecord[]): RecordStream {
  return {
    load: async () => records,
    append: async (record) => { records.push(record) },
  }
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
      recordStream: recordStreamFor(records),
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

  it('settles parallel safe tools before surfacing abort', async () => {
    const records: SessionRecord[] = []
    const provider: ModelProvider = {
      name: 'mock',
      async createMessage(): Promise<ModelResponse> {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'call-abort', name: 'abortTool', input: {} },
            { id: 'call-ok', name: 'okTool', input: {} },
          ],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      },
    }
    const abortTool: Tool = {
      name: 'abortTool',
      description: 'abort',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw abortError()
      },
    }
    const okTool: Tool = {
      name: 'okTool',
      description: 'ok',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ok: true, content: 'ok' }
      },
    }
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([abortTool, okTool], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [abortTool, okTool],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await assert.rejects(testLoop.run('test input'), (error: Error) => error.name === 'AbortError')

    const toolResults = records.filter((record) => record.type === 'tool_result')
    assert.equal(toolResults.length, 2)
    assert.equal(toolResults.find((record) => record.toolUseId === 'call-abort')?.errorCode, 'aborted')
    assert.equal(toolResults.find((record) => record.toolUseId === 'call-ok')?.ok, true)
  })

  it('records a recoverable turn interruption with remaining tasks on abort', async () => {
    const records: SessionRecord[] = []
    const controller = new AbortController()
    const provider = createMockProvider()
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const taskState = new Map([[
      '1',
      {
        id: '1',
        status: 'in_progress' as const,
        subject: 'Finish interrupted work',
        description: 'Keep this task recoverable',
        activeForm: 'Finishing interrupted work',
      },
    ]])
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set(), taskState },
      recordStream: recordStreamFor(records),
    })

    const runPromise = testLoop.run('please do the work', controller.signal, 'user-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort('user-cancel')
    await assert.rejects(runPromise, (error: Error) => error.name === 'AbortError')

    const interruption = records.find((record) => record.type === 'turn_interruption')
    assert.ok(interruption)
    assert.equal(interruption.type, 'turn_interruption')
    assert.equal(interruption.userMessageId, 'user-1')
    assert.equal(interruption.recoverable, true)
    assert.equal(interruption.remainingTasks[0]?.subject, 'Finish interrupted work')
  })

  it('does not record recoverable turn interruption for non-user aborts', async () => {
    const records: SessionRecord[] = []
    const controller = new AbortController()
    const provider = createMockProvider()
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    const runPromise = testLoop.run('please do the work', controller.signal, 'user-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort('exit')
    await assert.rejects(runPromise, (error: Error) => error.name === 'AbortError')

    assert.equal(records.some((record) => record.type === 'turn_interruption'), false)
  })

  it('persists partial assistant text before recording a user interruption', async () => {
    const records: SessionRecord[] = []
    const controller = new AbortController()
    const provider: ModelProvider = {
      name: 'mock',
      async createMessage(request: ModelRequest): Promise<ModelResponse> {
        request.onTextDelta?.('partial ')
        request.onTextDelta?.('answer')
        await new Promise<void>((_resolve, reject) => {
          request.retry?.signal?.addEventListener('abort', () => {
            reject(abortError())
          }, { once: true })
        })
        throw new Error('unreachable')
      },
    }
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    const runPromise = testLoop.run('please do the work', controller.signal, 'user-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort('user-cancel')
    await assert.rejects(runPromise, (error: Error) => error.name === 'AbortError')

    const assistant = records.find((record) => record.type === 'message' && record.role === 'assistant')
    if (!assistant || assistant.type !== 'message') assert.fail('Expected partial assistant message')
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content, 'partial answer')
    const interruption = records.find((record) => record.type === 'turn_interruption')
    assert.equal(interruption?.type, 'turn_interruption')
    assert.ok(
      records.findIndex((record) => record.id === assistant?.id)
      < records.findIndex((record) => record.id === interruption?.id),
    )
  })

  it('injects and consumes interrupted turn context when the user resumes', async () => {
    const records: SessionRecord[] = [{
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-old',
      prompt: 'old prompt',
      remainingTasks: [{
        id: '1',
        status: 'pending',
        subject: 'Resume me',
        description: 'Resume this task',
      }],
      recoverable: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      turnId: 'old-turn',
    }]
    const provider = createMockProvider()
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const stream = recordStreamFor(records)
    stream.update = async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index >= 0 && records[index]) records[index] = update(records[index])
    }
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: stream,
    })

    await testLoop.run('continue')

    assert.match(JSON.stringify(provider.requests[0].contextItems), /previous turn was interrupted/)
    const interruption = records.find((record) => record.type === 'turn_interruption')
    assert.equal(interruption?.type, 'turn_interruption')
    assert.equal(interruption?.recoverable, false)
    assert.equal(typeof interruption?.consumedAt, 'string')
  })

  it('recognizes Chinese resume intent for interrupted turns', async () => {
    const records: SessionRecord[] = [{
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-old',
      prompt: 'old prompt',
      remainingTasks: [{
        id: '1',
        status: 'pending',
        subject: 'Resume me',
        description: 'Resume this task',
      }],
      recoverable: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      turnId: 'old-turn',
    }]
    const provider = createMockProvider()
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const stream = recordStreamFor(records)
    stream.update = async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index >= 0 && records[index]) records[index] = update(records[index])
    }
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: stream,
    })

    await testLoop.run('继续')

    assert.match(JSON.stringify(provider.requests[0].contextItems), /previous turn was interrupted/)
  })

  it('recognizes Chinese abandon intent for interrupted turns', async () => {
    const records: SessionRecord[] = [{
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-old',
      prompt: 'old prompt',
      remainingTasks: [{
        id: '1',
        status: 'pending',
        subject: 'Resume me',
        description: 'Resume this task',
      }],
      recoverable: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      turnId: 'old-turn',
    }]
    const provider = createMockProvider()
    const permissionGate = new PermissionGate(noopPermission)
    const toolRunner = new ToolRunner([], permissionGate, {
      onRecord: async (record) => { records.push(record) },
    })
    const stream = recordStreamFor(records)
    stream.update = async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index >= 0 && records[index]) records[index] = update(records[index])
    }
    const testLoop = new AgentLoop({
      provider,
      model: 'mock-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner,
      toolContext: { cwd: process.cwd(), sessionId: 'test', readFiles: new Set() },
      recordStream: stream,
    })

    await testLoop.run('算了')

    assert.match(JSON.stringify(provider.requests[0].contextItems), /has been abandoned/)
  })
})
