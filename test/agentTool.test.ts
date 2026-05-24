import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { createAgentTool, filterToolsForSubAgent } from '../src/tools/agentTool.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate } from '../src/harness/permissions.js'
import type { ModelProvider, ModelRequest, Tool, ToolContext } from '../src/harness/types.js'

function toolContext(sessionId = 'parent'): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId,
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
  }
}

function safeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    async execute() {
      return { ok: true, content: 'tool ok' }
    },
  }
}

function readOnlyTool(name: string): Tool {
  return {
    ...safeTool(name),
    isReadOnly: true,
  }
}

test('filterToolsForSubAgent keeps only read-only non-agent tools', () => {
  const tools = [
    readOnlyTool('Agent'),
    readOnlyTool('bash'),
    readOnlyTool('readFile'),
    safeTool('safeButStateful'),
  ]

  assert.deepEqual(filterToolsForSubAgent(tools).map((tool) => tool.name), ['readFile'])
})

test('Agent tool keeps sub-agent records out of the parent record stream', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'sub-agent result', toolCalls: [] }
    },
  }
  const parentRecords: string[] = []
  let runtimeTools: Tool[] = []
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => runtimeTools,
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })
  runtimeTools = [agentTool]
  const runner = new ToolRunner(runtimeTools, new PermissionGate(async () => true), {
    onRecord: async (record) => { parentRecords.push(record.type) },
  })

  const result = await runner.run({
    id: 'call-1',
    name: 'Agent',
    input: { task: 'research this' },
  }, toolContext('parent'))

  assert.equal(result.ok, true)
  assert.equal(result.content, 'sub-agent result')
  assert.deepEqual(parentRecords, ['tool_use', 'tool_approval', 'tool_result'])
})

test('Agent tool uses an isolated agent cache source', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  await agentTool.execute({ task: 'hello' }, toolContext('parent-session'))

  assert.equal(requests.length, 1)
  assert.match(requests[0]!.cacheSource, /^agent:/)
  assert.notEqual(requests[0]!.cacheSource, 'agent:parent-session')
})

test('Agent tool honors maxTurns', async () => {
  let requests = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      requests += 1
      return {
        content: 'keep going',
        toolCalls: [{ id: `call-${requests}`, name: 'noop', input: {} }],
      }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('noop')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'loop', maxTurns: 1 }, toolContext())

  assert.equal(result.ok, false)
  assert.equal(requests, 1)
  assert.match(result.content, /exceeded maximum tool iterations/)
})

test('Agent tool runs sub-agent tools through a permission gate', async () => {
  const readOnlyConfirmTool: Tool = {
    name: 'readOnlyConfirm',
    description: 'read-only confirm',
    inputSchema: z.object({}).strict(),
    riskLevel: 'confirm',
    isReadOnly: true,
    async execute() {
      return { ok: true, content: 'should not execute' }
    },
  }
  let prompts = 0
  let requests = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      requests += 1
      if (requests === 1) {
        return {
          content: 'calling tool',
          toolCalls: [{ id: 'confirm-1', name: 'readOnlyConfirm', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyConfirmTool],
    permissionPrompt: async () => {
      prompts += 1
      return false
    },
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'try dangerous tool' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(prompts, 1)
})
