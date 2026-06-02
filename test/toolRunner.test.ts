import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { PermissionGate } from '../src/harness/permissions.js'
import { prepareRecordsForRequest } from '../src/harness/requestPrep.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { countTextTokens } from '../src/prompts/budget.js'
import type { SessionRecord, Tool, ToolProgressEvent } from '../src/harness/types.js'

test('tool runner executes safe tool without prompting', async () => {
  let prompted = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    prompted = true
    return true
  }), {
    onRecord: async (record) => { records.push(record) },
  })
  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(prompted, false)
  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(records.length, 3)
})

test('tool runner denies dangerous tool when permission is false', async () => {
  const tool: Tool = {
    name: 'Delete',
    description: 'delete',
    inputSchema: z.object({
      filePath: z.string(),
    }).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'deleted' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => false), {
    onRecord: async () => {},
  })
  const result = await runner.run({ id: 'call1', name: 'Delete', input: { filePath: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.ok, false)
  assert.match(result.content, /denied/)
})

test('tool runner returns structured validation errors before prompting or executing', async () => {
  let prompted = false
  let executed = false
  const tool: Tool = {
    name: 'validatedTool',
    description: 'validated',
    inputSchema: z.object({
      filePath: z.string(),
    }).strict(),
    riskLevel: 'confirm',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    prompted = true
    return true
  }), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run({ id: 'call1', name: 'validatedTool', input: { path: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.match(result.content, /Tool input validation failed for validatedTool/)
  assert.equal(prompted, false)
  assert.equal(executed, false)
  assert.equal(records.filter((record) => record.type === 'tool_use').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  assert.equal(records.some((record) => record.type === 'tool_approval'), false)
})

test('tool runner writes optional turnId to tool records', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'safeTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    undefined,
    'turn-1',
  )

  assert.equal(result.turnId, 'turn-1')
  assert.ok(records.every((record) => 'turnId' in record && record.turnId === 'turn-1'))
})

test('tool runner stores derived token count on tool results', async () => {
  const tool: Tool = {
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'hello world' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  await runner.run({ id: 'call1', name: 'echo', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  const result = records.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.equal(result._tokens, countTextTokens('echo\nhello world'))
})

test('tool runner applies maxResultSizeChars before persisting tool results', async () => {
  const tool: Tool = {
    name: 'limitedTool',
    description: 'limited',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    maxResultSizeChars: 5,
    execute: async () => ({ ok: true, content: '0123456789' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run({ id: 'call1', name: 'limitedTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.content, '01234\n\n[Tool result truncated: exceeded 5 chars; original 10 chars]')
  assert.equal(result._tokens, countTextTokens(`limitedTool\n${result.content}`))
  assert.equal(records.find((record) => record.type === 'tool_result'), result)

  const prepared = prepareRecordsForRequest(records, { contextWindow: 1_000_000, summaryOutputTokens: 0 })
  const preparedResult = prepared.find((record) => record.type === 'tool_result')
  assert.equal(preparedResult?.type, 'tool_result')
  assert.equal(preparedResult.content, result.content)
})

test('tool runner preserves unbounded tool results exactly', async () => {
  const tool: Tool = {
    name: 'unboundedTool',
    description: 'unbounded',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '0123456789' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })

  const result = await runner.run({ id: 'call1', name: 'unboundedTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.content, '0123456789')
})

test('tool runner persists structured display metadata without changing content', async () => {
  const tool: Tool = {
    name: 'summaryTool',
    description: 'summary',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({
      ok: true,
      content: 'line 1\nline 2',
      metadata: { display: { summary: 'Read 2 lines' } },
    }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })

  const result = await runner.run(
    { id: 'call1', name: 'summaryTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.content, 'line 1\nline 2')
  assert.deepEqual(result.display, { summary: 'Read 2 lines' })
})

test('tool runner pairs tool_use with aborted tool_result when permission aborts', async () => {
  const controller = new AbortController()
  const tool: Tool = {
    name: 'confirmTool',
    description: 'confirm',
    inputSchema: z.object({}).strict(),
    riskLevel: 'confirm',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    controller.abort('user-cancel')
    throw new DOMException('The operation was aborted.', 'AbortError')
  }), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'confirmTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    controller.signal,
  )

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'aborted')
  assert.equal(result.content, 'Interrupted by user')
  assert.equal(records.filter((record) => record.type === 'tool_use').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  assert.equal(records.find((record) => record.type === 'tool_result')?.toolUseId, 'call1')
})

test('tool runner runs preToolUse hooks after permission and blocks on nonzero exit', async () => {
  let executed = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  }, {
    preToolUse: [{
      matcher: 'safeTool',
      command: `${JSON.stringify(process.execPath)} -e "console.error('blocked by hook'); process.exit(7)"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.match(result.content, /Pre-tool hook blocked safeTool/)
  assert.match(result.content, /blocked by hook/)
  assert.equal(executed, false)
})

test('tool runner skips preToolUse hooks when matcher does not match', async () => {
  let executed = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  }, {
    preToolUse: [{
      matcher: 'Bash',
      command: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(executed, true)
})

test('tool runner runs postToolUse hooks after emitting tool result', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  }, {
    postToolUse: [{
      matcher: 'safeTool',
      command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log(data.tool + ':' + data.result.content) })"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, true)
  const resultIndex = records.findIndex((record) => record.type === 'tool_result')
  const hookIndex = records.findIndex((record) => record.type === 'message' && /postToolUse hook output for safeTool/.test(record.content))
  assert.ok(resultIndex >= 0)
  assert.ok(hookIndex > resultIndex)
  assert.match(records[hookIndex]?.type === 'message' ? records[hookIndex].content : '', /safeTool:done/)
})

test('tool runner emits progress around execution', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const progress: ToolProgressEvent[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
    onProgress: (event) => { progress.push(event) },
  })

  await runner.run(
    { id: 'call1', name: 'safeTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.deepEqual(progress.map((event) => event.phase), ['started', 'finished'])
  assert.deepEqual(progress.map((event) => event.call.id), ['call1', 'call1'])
})

test('tool runner finishes progress when execution fails', async () => {
  const tool: Tool = {
    name: 'failTool',
    description: 'fail',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      throw new Error('boom')
    },
  }
  const progress: string[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
    onProgress: (event) => { progress.push(event.phase) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'failTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.ok, false)
  assert.deepEqual(progress, ['started', 'finished'])
})
