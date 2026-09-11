import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { BUILT_IN_AGENT_DEFINITIONS, createAgentTool, filterToolsForSubAgent, prepareForkPreloadRecords } from '../src/tools/AgentTool/AgentTool.js'
import { AgentDefinitionLoader } from '../src/services/agents/agentDefinitionLoader.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate, type DenialStateStore } from '../src/harness/permissions.js'
import { displayCacheSource } from '../src/harness/cacheBreakDetection.js'
import type { ImageAttachmentImporter, ModelProvider, ModelRequest, SessionRecord, Tool, ToolContext } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(assertion(), true)
}

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

function dangerousReadOnlyTool(name: string): Tool {
  return {
    ...readOnlyTool(name),
    riskLevel: 'dangerous',
  }
}

test('filterToolsForSubAgent keeps only read-only non-agent tools', () => {
  const tools = [
    readOnlyTool('Agent'),
    dangerousReadOnlyTool('Bash'),
    readOnlyTool('Read'),
    safeTool('ExitPlanMode'),
    safeTool('safeButStateful'),
  ]

  assert.deepEqual(filterToolsForSubAgent(tools).map((tool) => tool.name), ['Read'])
})

test('filterToolsForSubAgent applies specialist agent tool policies', () => {
  const tools = [
    readOnlyTool('Glob'),
    readOnlyTool('Grep'),
    readOnlyTool('Read'),
    readOnlyTool('TaskCreate'),
    safeTool('Bash'),
    safeTool('Write'),
  ]
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')

  assert.ok(explore)
  assert.deepEqual(filterToolsForSubAgent(tools, explore).map((tool) => tool.name), ['Glob', 'Grep', 'Read', 'Bash'])
})

test('filterToolsForSubAgent limits MCP tools to configured servers', () => {
  const tools = [
    readOnlyTool('Read'),
    readOnlyTool('mcp__github__search'),
    readOnlyTool('mcp__linear__search'),
  ]
  const definition = {
    type: 'mcp-review',
    description: 'Uses one MCP server.',
    mcpServers: ['github'],
    disallowedTools: ['Agent'],
    maxTurns: 3,
    isReadOnlyAgent: true,
    getSystemPrompt: () => 'review',
  }

  assert.deepEqual(
    filterToolsForSubAgent(tools, definition).map((tool) => tool.name),
    ['Read', 'mcp__github__search'],
  )
})

test('Agent tool marks only read-only agent types as concurrency-safe inputs', () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
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

  assert.equal(BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'general')?.isReadOnlyAgent, true)
  assert.equal(BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')?.isReadOnlyAgent, true)
  assert.equal(BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')?.isReadOnlyAgent, true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'research', subagent_type: 'general' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'map', subagent_type: 'explore' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'design', subagent_type: 'plan' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'missing type' }), false)
})

test('Agent tool bridges sub-agent transcripts without leaking child tool records', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: 'sub-agent result',
        toolCalls: [],
        usage: { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 },
      }
    },
  }
  const parentRecords: SessionRecord[] = []
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
    onRecord: async (record) => { parentRecords.push(record) },
  })

  const result = await runner.run({
    id: 'call-1',
    name: 'Agent',
    input: { task: 'research this', subagent_type: 'general' },
  }, toolContext('parent'))

  assert.equal(result.ok, true)
  assert.equal(result.content, 'sub-agent result')
  assert.deepEqual(parentRecords.map((record) => record.type), ['tool_use', 'tool_approval', 'subagent_transcript', 'tool_result', 'message'])
  const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
  assert.ok(transcript && transcript.type === 'subagent_transcript')
  assert.equal(transcript.model, 'fake-model')
  assert.deepEqual(transcript.usage, { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 })
  assert.equal(transcript.summary, 'sub-agent result')
  assert.equal(transcript.recordCount, 2)
  assert.equal(transcript.messageCount, 2)
  assert.deepEqual(transcript.records, [])
  const summary = parentRecords.at(-1)
  assert.ok(summary && summary.type === 'message')
  assert.equal(summary.role, 'assistant')
  assert.match(summary.content, /<subagent-summary type="general"/)
  assert.match(summary.content, /tokens="15"/)
  assert.equal(result.display?.summary, 'Done (0 tool uses · 15 tokens · 1s)')
  assert.equal(result.display?.headerSuffix, 'fake-model')
})

test('Agent tool returns aggregated sub-agent output after max_tokens continuation', async () => {
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      if (calls === 1) return { content: 'sub-agent part one', toolCalls: [], stopReason: 'max_tokens' }
      return { content: 'sub-agent done', toolCalls: [] }
    },
  }
  const parentRecords: SessionRecord[] = []
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
    onRecord: async (record) => { parentRecords.push(record) },
  })

  const result = await runner.run({
    id: 'call-1',
    name: 'Agent',
    input: { task: 'research this', subagent_type: 'general', maxOutputTokens: 10 },
  }, toolContext('parent'))

  assert.equal(result.ok, true)
  assert.equal(result.content, 'sub-agent part one\n\nsub-agent done')
  assert.equal(calls, 2)
  const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
  assert.ok(transcript && transcript.type === 'subagent_transcript')
  assert.equal(transcript.summary, 'sub-agent part one\n\nsub-agent done')
})

test('Agent tool marks sub-agent output incomplete when max_tokens recovery is exhausted', async () => {
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: `sub-agent part ${calls}`, toolCalls: [], stopReason: 'max_tokens' }
    },
  }
  const parentRecords: SessionRecord[] = []
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
    onRecord: async (record) => { parentRecords.push(record) },
  })

  const result = await runner.run({
    id: 'call-1',
    name: 'Agent',
    input: { task: 'research this', subagent_type: 'general', maxOutputTokens: 10 },
  }, toolContext('parent'))

  assert.equal(result.ok, true)
  assert.equal(calls, 4)
  assert.match(result.content, /sub-agent part 1\n\nsub-agent part 2\n\nsub-agent part 3\n\nsub-agent part 4/)
  assert.match(result.content, /Sub-agent output may be incomplete/)
  const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
  assert.ok(transcript && transcript.type === 'subagent_transcript')
  assert.match(transcript.summary ?? '', /Sub-agent output may be incomplete/)
})

test('Agent tool can launch a background sub-agent and persist a sidechain transcript', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-agent-'))
  try {
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          content: 'background result',
          toolCalls: [],
          usage: { inputTokens: 4, cacheReadInputTokens: 1, outputTokens: 2 },
        }
      },
    }
    const parentRecords: SessionRecord[] = []
    let runtimeTools: Tool[] = []
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => runtimeTools,
      permissionPrompt: async () => true,
      cwd: root,
    })
    runtimeTools = [agentTool]
    const runner = new ToolRunner(runtimeTools, new PermissionGate(async () => true), {
      onRecord: async (record) => { parentRecords.push(record) },
    })

    const result = await runner.run({
      id: 'call-bg',
      name: 'Agent',
      input: {
        task: 'research in background',
        subagent_type: 'general',
        description: 'Background research',
        run_in_background: true,
      },
    }, toolContext('parent-session'))

    assert.equal(result.ok, true)
    assert.match(result.content, /Started general sub-agent/)
    assert.ok(parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'running' && record.model === 'fake-model'))

    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
    const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
    assert.ok(transcript && transcript.type === 'subagent_transcript')
    assert.equal(transcript.model, 'fake-model')
    assert.equal(transcript.status, 'completed')
    assert.equal(transcript.summary, 'background result')
    assert.ok(transcript.transcriptPath)
    const sidechain = await readFile(transcript.transcriptPath, 'utf8')
    assert.match(sidechain, /background result/)
    const completion = parentRecords.find((record) => record.type === 'message' && record.role === 'assistant' && /Background general agent/.test(record.content))
    assert.ok(completion)
    const completed = parentRecords.find((record) => record.type === 'subagent_task' && record.status === 'completed')
    assert.ok(completed && completed.type === 'subagent_task')
    assert.equal(completed.model, 'fake-model')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('custom agent background frontmatter defaults to background execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-agent-'))
  try {
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return { content: 'background by default', toolCalls: [] }
      },
    }
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: root,
      agentDefinitions: [{
        type: 'backgrounder',
        description: 'Runs in background by default.',
        background: true,
        disallowedTools: ['Agent'],
        maxTurns: 1,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'backgrounder',
      }],
    })
    const parentRecords: SessionRecord[] = []

    const result = await agentTool.execute({
      task: 'run later',
      subagent_type: 'backgrounder',
    }, {
      ...toolContext('parent-session'),
      appendRecord: async (record) => { parentRecords.push(record) },
    })

    assert.equal(result.ok, true)
    assert.match(result.content, /Started backgrounder sub-agent/)
    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit run_in_background false overrides custom agent background default', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'sync result', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'backgrounder',
      description: 'Runs in background by default.',
      background: true,
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'backgrounder',
    }],
  })

  const result = await agentTool.execute({
    task: 'run now',
    subagent_type: 'backgrounder',
    run_in_background: false,
  }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'sync result')
})

test('Agent tool uses routed sub-agent runtime without exposing model input', async () => {
  const parentProvider: ModelProvider = {
    name: 'parent',
    async createMessage() {
      throw new Error('parent provider should not be used for routed explore agent')
    },
  }
  let seenModel = ''
  const routedProvider: ModelProvider = {
    name: 'routed',
    async createMessage(request) {
      seenModel = request.model
      return { content: 'routed result', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider: parentProvider,
    model: 'parent-model',
    modelKey: 'parent-key',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    resolveSubagentModel: (subagentType) => {
      assert.equal(subagentType, 'explore')
      return {
        provider: routedProvider,
        model: 'explore-model',
        modelKey: 'explore-key',
        providerName: 'routed',
      }
    },
  })

  const result = await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'routed result')
  assert.equal(seenModel, 'explore-model')
})

test('custom agent model frontmatter requests a concrete model key', async () => {
  const parentProvider: ModelProvider = {
    name: 'parent',
    async createMessage() {
      throw new Error('parent provider should not be used')
    },
  }
  let requestedType = ''
  let requestedModelKey: string | undefined
  let seenModel = ''
  const routedProvider: ModelProvider = {
    name: 'routed',
    async createMessage(request) {
      seenModel = request.model
      return { content: 'model-specific result', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider: parentProvider,
    model: 'parent-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'modelled',
      description: 'Uses a configured model.',
      model: 'fast-model-key',
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'modelled',
    }],
    resolveSubagentModel: (subagentType, modelKey) => {
      requestedType = subagentType
      requestedModelKey = modelKey
      return {
        provider: routedProvider,
        model: 'fast-provider-model',
        modelKey,
        providerName: 'routed',
      }
    },
  })

  const result = await agentTool.execute({ task: 'use model', subagent_type: 'modelled' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'model-specific result')
  assert.equal(requestedType, 'modelled')
  assert.equal(requestedModelKey, 'fast-model-key')
  assert.equal(seenModel, 'fast-provider-model')
})

test('custom agent model inherit skips sub-agent routing', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'parent',
    async createMessage(request) {
      requests.push(request)
      return { content: 'parent result', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'parent-model',
    modelKey: 'parent-key',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'inheriting',
      description: 'Inherits parent runtime.',
      model: 'inherit',
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'inheriting',
    }],
    resolveSubagentModel: () => {
      throw new Error('routing should not be called for model: inherit')
    },
  })

  const result = await agentTool.execute({ task: 'inherit model', subagent_type: 'inheriting' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'parent result')
  assert.equal(requests[0]!.model, 'parent-model')
})

test('custom agent unknown model key returns a clear tool error', async () => {
  const agentTool = createAgentTool({
    provider: {
      name: 'parent',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'parent-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'missing-model',
      description: 'References a missing model.',
      model: 'does-not-exist',
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'missing',
    }],
    resolveSubagentModel: () => undefined,
  })

  const result = await agentTool.execute({ task: 'use missing model', subagent_type: 'missing-model' }, toolContext())

  assert.equal(result.ok, false)
  assert.match(result.content, /Unknown model for subagent "missing-model": does-not-exist/)
})

test('Agent tool aborts sub-agent runs after agentTimeoutMs', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      await new Promise((_resolve, reject) => {
        request.retry?.signal?.addEventListener('abort', () => {
          reject(request.retry?.signal?.reason)
        }, { once: true })
      })
      return { content: 'unused', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentTimeoutMs: 5,
  })

  const result = await agentTool.execute({ task: 'slow task', subagent_type: 'general' }, toolContext())

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'aborted')
  assert.match(result.content, /timed out/)
})

test('Agent tool does not persist sub-agent denial state into the parent store', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{ id: 'inner-1', name: 'ConfirmRead', input: {} }],
      }
    },
  }
  const confirmReadTool: Tool = {
    ...readOnlyTool('ConfirmRead'),
    riskLevel: 'confirm',
  }
  let parentStoreWrites = 0
  const denialStateStore: DenialStateStore = {
    async getDenialState() {
      return { streaks: {}, total: 0 }
    },
    async setDenialState() {
      parentStoreWrites += 1
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [confirmReadTool],
    permissionPrompt: async () => false,
    denialStateStore,
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'needs approval', subagent_type: 'general' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(parentStoreWrites, 0)
})

test('custom agent permissionMode bypass auto approves confirm tools inside the sub-agent', async () => {
  let promptCalls = 0
  let confirmRuns = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done after confirm tool', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{ id: 'confirm-1', name: 'ConfirmRead', input: {} }],
      }
    },
  }
  const confirmReadTool: Tool = {
    ...readOnlyTool('ConfirmRead'),
    riskLevel: 'confirm',
    async execute() {
      confirmRuns += 1
      return { ok: true, content: 'confirmed' }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [confirmReadTool],
    permissionPrompt: async () => {
      promptCalls += 1
      return false
    },
    permissionMode: () => 'default',
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'auto-review',
      description: 'Auto approves confirm tools.',
      permissionMode: 'bypass',
      tools: ['ConfirmRead'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'auto review',
    }],
  })

  const result = await agentTool.execute({ task: 'run confirm', subagent_type: 'auto-review' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done after confirm tool')
  assert.equal(confirmRuns, 1)
  assert.equal(promptCalls, 0)
})

test('parent bypass permission mode is preserved over custom agent permissionMode', async () => {
  let confirmRuns = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done in bypass', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{ id: 'confirm-1', name: 'ConfirmRead', input: {} }],
      }
    },
  }
  const confirmReadTool: Tool = {
    ...readOnlyTool('ConfirmRead'),
    riskLevel: 'confirm',
    async execute() {
      confirmRuns += 1
      return { ok: true, content: 'confirmed' }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [confirmReadTool],
    permissionPrompt: async () => false,
    permissionMode: () => 'bypass',
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'planish',
      description: 'Would otherwise use plan mode.',
      permissionMode: 'plan',
      tools: ['ConfirmRead'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'planish',
    }],
  })

  const result = await agentTool.execute({ task: 'run confirm', subagent_type: 'planish' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done in bypass')
  assert.equal(confirmRuns, 1)
})

test('custom agent skills are activated for the child context and missing skills only warn', async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        requests.push(request)
        return { content: 'skill-aware result', toolCalls: [] }
      },
    }
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: process.cwd(),
      skills: [
        {
          name: 'debugging',
          description: 'Debug failures.',
          content: 'Use focused repros.',
          inclusion: 'manual',
        },
      ],
      agentDefinitions: [{
        type: 'skilled',
        description: 'Uses skills.',
        skills: ['debugging', 'missing'],
        disallowedTools: ['Agent'],
        maxTurns: 1,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'skilled',
      }],
    })

    const result = await agentTool.execute({ task: 'use skill', subagent_type: 'skilled' }, toolContext())

    assert.equal(result.ok, true)
    const context = JSON.stringify(requests[0]!.contextItems)
    assert.match(context, /activeSkills/)
    assert.match(context, /Use focused repros/)
    assert.ok(warnings.some((warning) => warning.includes("Custom agent 'skilled' references missing skill 'missing'")))
  } finally {
    console.warn = originalWarn
  }
})

test('custom agent worktree isolation runs child tools in the isolated cwd and reports changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-worktree-agent-'))
  try {
    const worktreePath = path.join(root, 'worktree')
    const seenCwds: string[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
          return { content: 'worktree task done', toolCalls: [] }
        }
        return {
          content: '',
          toolCalls: [{ id: 'mark-1', name: 'MarkCwd', input: {} }],
        }
      },
    }
    const markCwdTool: Tool = {
      name: 'MarkCwd',
      description: 'records cwd',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      async execute(_input, context) {
        seenCwds.push(context.cwd)
        return { ok: true, content: `cwd=${context.cwd}` }
      },
    }
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [markCwdTool],
      permissionPrompt: async () => true,
      cwd: root,
      worktreeManager: {
        getPath: () => worktreePath,
        async create() {
          return { isolation: 'worktree', path: worktreePath, baseRef: 'abc123' }
        },
        async summarize() {
          return 'M src/example.ts'
        },
        async exists() {
          return true
        },
        async inspect() {
          return { exists: true, worktreePath, summary: 'M src/example.ts' }
        },
        async cleanup() {
          return { removed: true, worktreePath }
        },
      },
      agentDefinitions: [{
        type: 'writer',
        description: 'Writes in a worktree.',
        isolation: 'worktree',
        tools: ['MarkCwd'],
        disallowedTools: ['Agent'],
        maxTurns: 3,
        isReadOnlyAgent: false,
        getSystemPrompt: () => 'writer',
      }],
    })

    const result = await agentTool.execute({ task: 'write safely', subagent_type: 'writer' }, toolContext('parent-session'))

    assert.equal(result.ok, true)
    assert.equal(seenCwds[0], worktreePath)
    assert.match(result.content, /Worktree:/)
    const subagent = result.metadata?.subagent as Record<string, unknown> | undefined
    assert.equal(subagent?.isolation, 'worktree')
    assert.equal(subagent?.worktreePath, worktreePath)
    assert.equal(subagent?.worktreeBaseRef, 'abc123')
    assert.equal(subagent?.worktreeChangeSummary, 'M src/example.ts')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('custom agent worktree isolation rejects read-only agent definitions', async () => {
  const agentTool = createAgentTool({
    provider: {
      name: 'fake',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [{
      type: 'readonly-isolated',
      description: 'Invalid isolation.',
      isolation: 'worktree',
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'readonly',
    }],
  })

  const result = await agentTool.execute({ task: 'read only', subagent_type: 'readonly-isolated' }, toolContext())

  assert.equal(result.ok, false)
  assert.match(result.content, /cannot use worktree isolation while marked read-only/)
})

test('background worktree agent records planned path and final change summary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-worktree-agent-'))
  try {
    const worktreePath = path.join(root, 'worktree')
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return { content: 'background worktree done', toolCalls: [] }
      },
    }
    const parentRecords: SessionRecord[] = []
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: root,
      worktreeManager: {
        getPath: () => worktreePath,
        async create() {
          return { isolation: 'worktree', path: worktreePath, baseRef: 'def456' }
        },
        async summarize() {
          return 'A generated.txt'
        },
        async exists() {
          return true
        },
        async inspect() {
          return { exists: true, worktreePath, summary: 'A generated.txt' }
        },
        async cleanup() {
          return { removed: true, worktreePath }
        },
      },
      agentDefinitions: [{
        type: 'bg-writer',
        description: 'Background writer.',
        isolation: 'worktree',
        background: true,
        disallowedTools: ['Agent'],
        maxTurns: 1,
        isReadOnlyAgent: false,
        getSystemPrompt: () => 'bg writer',
      }],
    })

    const result = await agentTool.execute({
      task: 'write later',
      subagent_type: 'bg-writer',
    }, {
      ...toolContext('parent-session'),
      appendRecord: async (record) => { parentRecords.push(record) },
    })

    assert.equal(result.ok, true)
    const running = parentRecords.find((record) => record.type === 'subagent_task' && record.status === 'running')
    assert.ok(running && running.type === 'subagent_task')
    assert.equal(running.worktreePath, worktreePath)

    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
    const completed = parentRecords.find((record) => record.type === 'subagent_task' && record.status === 'completed')
    assert.ok(completed && completed.type === 'subagent_task')
    assert.equal(completed.worktreePath, worktreePath)
    assert.equal(completed.worktreeBaseRef, 'def456')
    assert.equal(completed.worktreeChangeSummary, 'A generated.txt')
    const completion = parentRecords.find((record) => record.type === 'message' && record.role === 'assistant')
    assert.ok(completion && completion.type === 'message')
    assert.match(completion.content, /Worktree:/)
    assert.match(completion.content, /A generated\.txt/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('subagent summary reports partial token usage and structured critical files', async () => {
  const records: SessionRecord[] = []
  const summaryTool: Tool = {
    name: 'summary',
    description: 'summary metadata',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    async execute() {
      return {
        ok: true,
        content: 'ok',
        metadata: {
          subagent: {
            type: 'plan',
            usage: { inputTokens: 7, outputTokens: 5 },
            criticalFiles: ['src/a,b.ts', 'test/agentTool.test.ts'],
          },
        },
      }
    },
  }
  const runner = new ToolRunner([summaryTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  await runner.run({ id: 'summary-1', name: 'summary', input: {} }, toolContext())

  const summary = records.find((record) => record.type === 'message' && record.role === 'assistant')
  assert.ok(summary && summary.type === 'message')
  assert.match(summary.content, /tokens="12"/)
  assert.match(summary.content, /<critical-file>src\/a,b\.ts<\/critical-file>/)
  assert.match(summary.content, /<critical-file>test\/agentTool\.test\.ts<\/critical-file>/)
  assert.doesNotMatch(summary.content, /critical_files=/)
})

test('Agent tool bounds persisted sub-agent results', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'x'.repeat(40_000), toolCalls: [] }
    },
  }
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
    onRecord: async () => {},
  })

  const result = await runner.run({
    id: 'call-1',
    name: 'Agent',
    input: { task: 'research this', subagent_type: 'general' },
  }, toolContext('parent'))

  assert.equal(result.ok, true)
  assert.equal(result.content.slice(0, 32_000), 'x'.repeat(32_000))
  assert.match(result.content, /Tool result truncated: exceeded 32000 chars; original 40000 chars/)
})

test('Agent tool exposes sub-agent usage, verdict, and critical files in metadata', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: [
          'Plan details.',
          '',
          '### Critical Files for Implementation',
          '- `src/tools/agentTool.ts` - metadata extraction',
          '2. test/agentTool.test.ts',
          '',
          'VERDICT: PASS',
        ].join('\n'),
        toolCalls: [],
        usage: { inputTokens: 100, cacheReadInputTokens: 20, outputTokens: 30 },
      }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'plan it', subagent_type: 'plan' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  const subagent = result.metadata?.subagent as Record<string, unknown> | undefined
  assert.ok(subagent)
  assert.equal(subagent.type, 'plan')
  assert.equal(typeof subagent.agentId, 'string')
  assert.equal(subagent.model, 'fake-model')
  assert.deepEqual(subagent.usage, { inputTokens: 100, cacheReadInputTokens: 20, outputTokens: 30 })
  assert.equal(subagent.verdict, 'PASS')
  assert.deepEqual(subagent.criticalFiles, ['src/tools/agentTool.ts', 'test/agentTool.test.ts'])
})

test('Agent tool ignores prose and non-path tokens under Critical Files heading', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: [
          'Plan details.',
          '',
          '### Critical Files for Implementation',
          '- some unrelated note about Agent tool',
          '- TODO',
          '- `not a path`',
          '- `src/tools/agentTool.ts` - metadata extraction',
          '- test/agentTool.test.ts:12',
          '4. package.json',
          '',
          'VERDICT: PASS',
        ].join('\n'),
        toolCalls: [],
      }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'plan it', subagent_type: 'plan' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  const subagent = result.metadata?.subagent as Record<string, unknown> | undefined
  assert.ok(subagent)
  assert.deepEqual(subagent.criticalFiles, ['src/tools/agentTool.ts', 'test/agentTool.test.ts:12', 'package.json'])
})

test('one-shot explore and plan agents suppress parent context summary messages', async () => {
  for (const subagentType of ['explore', 'plan']) {
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return { content: `${subagentType} result`, toolCalls: [] }
      },
    }
    let runtimeTools: Tool[] = []
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => runtimeTools,
      permissionPrompt: async () => true,
      cwd: process.cwd(),
    })
    runtimeTools = [agentTool]
    const records: SessionRecord[] = []
    const runner = new ToolRunner(runtimeTools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })

    const result = await runner.run({
      id: `${subagentType}-1`,
      name: 'Agent',
      input: { task: 'map it', subagent_type: subagentType },
    }, toolContext('parent-session'), undefined, 'turn-1')

    assert.equal(result.ok, true)
    assert.equal(result.content, `${subagentType} result`)
    assert.ok(records.some((record) => record.type === 'subagent_transcript'))
    assert.ok(!records.some(
      (record) => record.type === 'message'
        && record.role === 'assistant'
        && /<subagent-summary/.test(record.content),
    ))
  }
})

test('Agent tool passes requested maxOutputTokens into the sub-agent request', async () => {
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
    tools: () => [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  await agentTool.execute({ task: 'map files', subagent_type: 'explore', maxOutputTokens: 123 }, toolContext())

  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.maxOutputTokens, 123)
  assert.match(requests[0]!.system ?? '', /under approximately 92 words/)
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

  await agentTool.execute({ task: 'hello', subagent_type: 'general' }, toolContext('parent-session'))

  assert.equal(requests.length, 1)
  assert.match(requests[0]!.cacheSource, /^agent:/)
  assert.notEqual(displayCacheSource(requests[0]!.cacheSource!), 'agent:parent-session')
})

test('fork Agent preloads bounded parent records and uses the parent fork cache source', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const parentRecords: SessionRecord[] = [{
    type: 'message',
    id: 'parent-1',
    role: 'user',
    content: 'parent context',
    createdAt: '2026-05-10T00:00:00.000Z',
  }, {
    type: 'subagent_transcript',
    id: 'transcript-1',
    agentId: 'child',
    subagentType: 'general',
    summary: 'nested child summary',
    records: [],
    usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 0 },
    createdAt: '2026-05-10T00:00:01.000Z',
  }]
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => parentRecords,
  })

  const result = await agentTool.execute({ task: 'continue from parent', subagent_type: 'fork' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(displayCacheSource(requests[0]!.cacheSource!), 'agent:fork:parent-session')
  assert.ok(requests[0]!.contextItems?.some(
    (item) => item.kind === 'message'
      && item.message.id === 'parent-1'
      && item.message.content === 'parent context',
  ))
  assert.ok(!requests[0]!.contextItems?.some(
    (item) => item.kind === 'message'
      && /nested child summary/.test(item.message.content),
  ))
  assert.doesNotMatch(requests[0]!.system ?? '', /Forked Conversation Context/)
  assert.ok(requests[0]!.contextItems?.some(
    (item) => item.kind === 'message'
      && item.message.role === 'user'
      && /Forked Conversation Context/.test(item.message.content),
  ))
})

test('prepareForkPreloadRecords keeps the recent tail within budget', () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old',
      role: 'user',
      content: 'x'.repeat(600),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'recent',
      role: 'assistant',
      content: 'recent context',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
  ]

  const prepared = prepareForkPreloadRecords(records, 50)

  assert.deepEqual(prepared.map((record) => record.type === 'message' ? record.id : record.type), ['recent'])
})

test('fork Agent reports parent record load failures clearly', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'unused', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => {
      throw new Error('bad jsonl')
    },
  })

  const result = await agentTool.execute({ task: 'continue from parent', subagent_type: 'fork' }, toolContext('parent-session'))

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'execution_failed')
  assert.match(result.content, /Fork failed: parent records load error: bad jsonl/)
})

test('Agent tool gives sub-agents an independent abort signal bridged from the parent', async () => {
  const parentAbort = new AbortController()
  let subAgentSignal: AbortSignal | undefined
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      subAgentSignal = request.retry?.signal
      assert.ok(subAgentSignal)
      assert.notEqual(subAgentSignal, parentAbort.signal)
      assert.equal(subAgentSignal.aborted, false)
      parentAbort.abort('stop parent')
      assert.equal(subAgentSignal.aborted, true)
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
  const context = { ...toolContext('parent-session'), abortSignal: parentAbort.signal }

  const result = await agentTool.execute({ task: 'hello', subagent_type: 'general' }, context)

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(subAgentSignal?.aborted, true)
})

test('Agent tool runs subagentStart hooks before the sub-agent model request', async () => {
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
    hooks: {
      subagentStart: [{
        matcher: 'explore',
        command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log('agent-type:' + data.agentType) })"`,
      }],
    },
  })

  await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext('parent-session'))

  assert.equal(requests.length, 1)
  assert.ok(requests[0]!.contextItems?.some(
    (item) => item.kind === 'message'
      && item.message.role === 'user'
      && /subagentStart hook output/.test(item.message.content)
      && /agent-type:explore/.test(item.message.content),
  ))
})

test('Agent tool appends subagentStop hook output to the parent-visible result', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'sub-agent report', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    hooks: {
      subagentStop: [{
        matcher: 'explore',
        command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log('stopped:' + data.agentType + ':' + data.response) })"`,
      }],
    },
  })

  const result = await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.match(result.content, /^sub-agent report/)
  assert.match(result.content, /subagentStop hook output/)
  assert.match(result.content, /stopped:explore:sub-agent report/)
})

test('Agent tool preserves subagentStop hook output when the sub-agent result is truncated', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'x'.repeat(100), toolCalls: [] }
    },
  }
  const tinyAgent = {
    type: 'tiny-hooks',
    description: 'Tiny reports with hooks.',
    tools: ['Read'],
    disallowedTools: ['Agent'],
    maxTurns: 2,
    maxResultSizeChars: 12,
    isReadOnlyAgent: true,
    getSystemPrompt: () => 'Keep it tiny.',
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [...BUILT_IN_AGENT_DEFINITIONS, tinyAgent],
    hooks: {
      subagentStop: [{
        matcher: 'tiny-hooks',
        command: `${JSON.stringify(process.execPath)} -e "console.log('hook tail survives')"`,
      }],
    },
  })

  const result = await agentTool.execute({ task: 'short report', subagent_type: 'tiny-hooks' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.equal(result.content.slice(0, 12), 'x'.repeat(12))
  assert.match(result.content, /Tool result truncated: exceeded 12 chars; original 100 chars/)
  assert.match(result.content, /subagentStop hook output/)
  assert.match(result.content, /hook tail survives/)
})

test('Agent tool appends subagentStop hook failures and blocking errors to the result', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'sub-agent report', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    hooks: {
      subagentStop: [
        {
          matcher: 'general',
          command: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
        },
        {
          matcher: 'general',
          command: `${JSON.stringify(process.execPath)} -e "console.log('__HANEKAWA_HOOK__'); console.log('{\\"blockingError\\":\\"stop blocked\\"}'); process.exit(1)"`,
        },
      ],
    },
  })

  const result = await agentTool.execute({ task: 'research', subagent_type: 'general' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.match(result.content, /Hook failures:/)
  assert.match(result.content, /subagentStop hook failed: .* exited with code 7/)
  assert.match(result.content, /Hook blocking errors:/)
  assert.match(result.content, /stop blocked/)
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
  const parentRecords: SessionRecord[] = []

  const result = await agentTool.execute({
    task: 'loop',
    subagent_type: 'general',
    maxTurns: 1,
  }, {
    ...toolContext(),
    appendRecord: async (record) => { parentRecords.push(record) },
  })

  assert.equal(result.ok, true)
  assert.equal(requests, 1)
  assert.match(result.content, /keep going/)
  assert.match(result.content, /Sub-agent output may be incomplete: reached max turns limit \(1\)/)
  const subagent = result.metadata?.subagent as Record<string, unknown> | undefined
  assert.equal(subagent?.stopReason, 'max_turns')
  assert.equal(subagent?.truncated, true)
  const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
  assert.ok(transcript && transcript.type === 'subagent_transcript')
  assert.equal(transcript.stopReason, 'max_turns')
  assert.equal(transcript.truncated, true)
  assert.match(transcript.summary ?? '', /Sub-agent output may be incomplete: reached max turns limit \(1\)/)
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

  const result = await agentTool.execute({ task: 'try dangerous tool', subagent_type: 'general' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(prompts, 1)
})

test('Agent tool inherits parent always-allow session rules', async () => {
  const readOnlyConfirmTool: Tool = {
    name: 'readOnlyConfirm',
    description: 'read-only confirm',
    inputSchema: z.object({
      command: z.string(),
    }).strict(),
    riskLevel: 'confirm',
    isReadOnly: true,
    async execute() {
      executions += 1
      return { ok: true, content: 'allowed by inherited rule' }
    },
  }
  let executions = 0
  let prompts = 0
  let requests = 0
  const parentGate = new PermissionGate(async () => true)
  parentGate.addSessionRule({
    toolName: 'readOnlyConfirm',
    contentPattern: '*cargo test*',
    behavior: 'allow',
    source: 'session',
  })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      requests += 1
      if (requests === 1) {
        return {
          content: 'calling inherited tool',
          toolCalls: [{ id: 'confirm-1', name: 'readOnlyConfirm', input: { command: 'cargo test' } }],
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
    getSessionRules: () => parentGate.getSessionRules(),
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'run inherited command', subagent_type: 'general' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(prompts, 0)
  assert.equal(executions, 1)
})

test('Agent tool omits project context for explore and plan agents', async () => {
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
    tools: () => [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    projectContext: '# Project rules\nDo expensive things.',
  })

  await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext())

  assert.equal(requests.length, 1)
  assert.doesNotMatch(requests[0]!.system ?? '', /Project rules/)
  assert.match(requests[0]!.system ?? '', /code exploration specialist/)
})

test('Agent tool description teaches effective sub-agent prompting', async () => {
  const agentTool = createAgentTool({
    provider: {
      name: 'fake',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  assert.match(agentTool.description, /complex, multi-step/)
  assert.match(agentTool.description, /Do NOT use when/)
  assert.match(agentTool.description, /agent starts cold/)
  assert.match(agentTool.description, /Never delegate understanding/)
  assert.match(agentTool.description, /Always pass it explicitly/)
})

test('Agent tool snapshots agent definitions at creation time', async () => {
  const mutableDefinitions = [...BUILT_IN_AGENT_DEFINITIONS]
  const agentTool = createAgentTool({
    provider: {
      name: 'fake',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: mutableDefinitions,
  })

  mutableDefinitions.push({
    type: 'late-agent',
    description: 'Definition added after tool creation.',
    disallowedTools: ['Agent'],
    maxTurns: 1,
    isReadOnlyAgent: true,
    getSystemPrompt: () => 'late prompt',
  })

  assert.doesNotMatch(agentTool.description, /late-agent/)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'late', subagent_type: 'late-agent' }), false)
  const result = await agentTool.execute({ task: 'late', subagent_type: 'late-agent' }, toolContext())
  assert.equal(result.ok, false)
  assert.match(result.content, /Unknown subagent_type "late-agent"/)
})

test('custom agent reload can refresh a runtime Agent tool', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  const home = path.join(root, 'home')
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'foo result', toolCalls: [] }
    },
  }
  let agentDefinitions = [...BUILT_IN_AGENT_DEFINITIONS]
  const createRuntimeAgentTool = () => createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd,
    agentDefinitions,
  })

  try {
    await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
    const beforeReload = createRuntimeAgentTool()
    const missing = await beforeReload.execute({ task: 'hello', subagent_type: 'foo' }, toolContext())
    assert.equal(missing.ok, false)
    assert.match(missing.content, /Unknown subagent_type "foo"/)

    await writeFile(path.join(cwd, '.myagent', 'agents', 'foo.md'), agentFile({
      name: 'foo',
      description: 'Reloaded foo agent.',
      tools: [],
      body: 'You are foo.',
    }))
    const customDefinitions = await new AgentDefinitionLoader(cwd, home).list()
    agentDefinitions = [...BUILT_IN_AGENT_DEFINITIONS, ...customDefinitions]
    const afterReload = createRuntimeAgentTool()

    const result = await afterReload.execute({ task: 'hello', subagent_type: 'foo' }, toolContext())

    assert.equal(result.ok, true)
    assert.equal(result.content, 'foo result')
    assert.match(requests[0]!.system ?? '', /You are foo\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explore agent prompt enforces read-only fact finding', async () => {
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')

  assert.ok(explore)
  const prompt = explore.getSystemPrompt()
  // The read-only cage is enforced by permissionMode/tools/disallowedTools, not
  // by a prohibition banner; the prompt states the non-obvious Bash contract.
  assert.doesNotMatch(prompt ?? '', /READ-ONLY MODE/)
  assert.match(prompt ?? '', /read-only, and every other shell command is denied/)
  assert.match(prompt ?? '', /Glob, Grep, Read, and Bash/)
  assert.match(prompt ?? '', /Prefer parallel read-only searches/)
  assert.match(prompt ?? '', /file paths and line numbers/)
  assert.match(prompt ?? '', /high-signal findings/)
})

test('plan agent prompt defines read-only architecture planning process', async () => {
  const plan = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')

  assert.ok(plan)
  const prompt = plan.getSystemPrompt()
  assert.doesNotMatch(prompt ?? '', /READ-ONLY MODE/)
  assert.match(prompt ?? '', /no file-editing tools/)
  assert.match(prompt ?? '', /Glob, Grep, and Read/)
  assert.match(prompt ?? '', /sequencing, dependencies, and the trade-offs/)
  assert.match(prompt ?? '', /Critical Files for Implementation/)
  assert.match(prompt ?? '', /3-5 files/)
})

test('specialist agent prompts frame report length by audience, not a word cap', async () => {
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')
  const plan = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')

  assert.ok(explore)
  assert.ok(plan)
  const explorePrompt = explore.getSystemPrompt() ?? ''
  assert.doesNotMatch(explorePrompt, /\d+ words/)
  assert.match(explorePrompt, /Report only what the caller asked for/)
  assert.match(plan.getSystemPrompt() ?? '', /Required Output/)
})

test('Agent tool requires an explicit subagent_type', async () => {
  const agentTool = createAgentTool({
    provider: {
      name: 'fake',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  await assert.rejects(
    () => agentTool.execute({ task: 'hello' }, toolContext()),
    /subagent_type/,
  )
})

test('AgentDefinitionLoader merges global, project, and local agent definitions by name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'project')
  try {
    await mkdir(path.join(home, '.myagent', 'agents'), { recursive: true })
    await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
    await mkdir(path.join(cwd, '.myagent', 'agents.local'), { recursive: true })
    await writeFile(path.join(home, '.myagent', 'agents', 'review.md'), agentFile({
      name: 'reviewer',
      description: 'global definition',
      body: 'global prompt',
    }))
    await writeFile(path.join(cwd, '.myagent', 'agents', 'review.md'), agentFile({
      name: 'reviewer',
      description: 'project definition',
      body: 'project prompt',
    }))
    await writeFile(path.join(cwd, '.myagent', 'agents.local', 'review.md'), agentFile({
      name: 'reviewer',
      description: 'local definition',
      body: 'local prompt',
    }))

    const definitions = await new AgentDefinitionLoader(cwd, home).list()
    const reviewer = definitions.find((definition) => definition.type === 'reviewer')

    assert.ok(reviewer)
    assert.equal(reviewer.description, 'local definition')
    assert.equal(reviewer.getSystemPrompt(), 'local prompt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader parses extended custom agent frontmatter fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  try {
    await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
    await writeFile(path.join(cwd, '.myagent', 'agents', 'v2.md'), agentFile({
      name: 'v2-agent',
      description: 'Uses v2 fields.',
      model: 'fast',
      permissionMode: 'bypass',
      skills: ['debugging', 'testing'],
      mcpServers: ['github'],
      background: true,
      isolation: 'worktree',
      body: 'v2 prompt',
    }))

    const definitions = await new AgentDefinitionLoader(cwd, path.join(root, 'home')).list()
    const definition = definitions.find((item) => item.type === 'v2-agent')

    assert.ok(definition)
    assert.equal(definition.model, 'fast')
    assert.equal(definition.permissionMode, 'bypass')
    assert.deepEqual(definition.skills, ['debugging', 'testing'])
    assert.deepEqual(definition.mcpServers, ['github'])
    assert.equal(definition.background, true)
    assert.equal(definition.isolation, 'worktree')
    assert.equal(definition.maxTurns, 30)
    assert.equal(definition.getSystemPrompt(), 'v2 prompt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader parses CRLF frontmatter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  try {
    const agentsDir = path.join(cwd, '.myagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      path.join(agentsDir, 'windows.md'),
      agentFile({
        name: 'windows-agent',
        description: 'Uses Windows line endings.',
        body: 'Windows agent prompt.',
      }).replace(/\n/g, '\r\n'),
    )

    const definitions = await new AgentDefinitionLoader(cwd, path.join(root, 'home')).list()
    const definition = definitions.find((item) => item.type === 'windows-agent')

    assert.ok(definition)
    assert.equal(definition.description, 'Uses Windows line endings.')
    assert.equal(definition.getSystemPrompt(), 'Windows agent prompt.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader repairs problematic top-level description scalars', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  try {
    const agentsDir = path.join(cwd, '.myagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      path.join(agentsDir, 'compat.md'),
      [
        '---',
        'name: compat-agent',
        'description: Reviews code: correctness and safety.',
        '---',
        'Review the implementation.',
        '',
      ].join('\n'),
    )

    const definitions = await new AgentDefinitionLoader(cwd, path.join(root, 'home')).list()
    const definition = definitions.find((item) => item.type === 'compat-agent')

    assert.ok(definition)
    assert.equal(definition.description, 'Reviews code: correctness and safety.')
    assert.equal(definition.getSystemPrompt(), 'Review the implementation.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader overrides v2 fields when later directories override an agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'project')
  try {
    await mkdir(path.join(home, '.myagent', 'agents'), { recursive: true })
    await mkdir(path.join(cwd, '.myagent', 'agents.local'), { recursive: true })
    await writeFile(path.join(home, '.myagent', 'agents', 'review.md'), agentFile({
      name: 'reviewer',
      description: 'global definition',
      model: 'slow',
      background: false,
      body: 'global prompt',
    }))
    await writeFile(path.join(cwd, '.myagent', 'agents.local', 'review.md'), agentFile({
      name: 'reviewer',
      description: 'local definition',
      model: 'fast',
      background: true,
      skills: ['local-skill'],
      body: 'local prompt',
    }))

    const definitions = await new AgentDefinitionLoader(cwd, home).list()
    const reviewer = definitions.find((definition) => definition.type === 'reviewer')

    assert.ok(reviewer)
    assert.equal(reviewer.description, 'local definition')
    assert.equal(reviewer.model, 'fast')
    assert.equal(reviewer.background, true)
    assert.deepEqual(reviewer.skills, ['local-skill'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader honors explicit custom maxTurns over the default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  try {
    await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
    await writeFile(path.join(cwd, '.myagent', 'agents', 'limited.md'), agentFile({
      name: 'limited',
      description: 'Explicit max turns.',
      maxTurns: 7,
      body: 'limited prompt',
    }))

    const definitions = await new AgentDefinitionLoader(cwd, path.join(root, 'home')).list()
    const definition = definitions.find((item) => item.type === 'limited')

    assert.ok(definition)
    assert.equal(definition.maxTurns, 7)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent tool supports custom subagent types and dynamic descriptions', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'security report', toolCalls: [] }
    },
  }
  const securityAgent = {
    type: 'security-review',
    description: 'Adversarial security review against changes.',
    tools: ['Glob', 'Grep', 'Read'],
    disallowedTools: ['Agent'],
    maxTurns: 15,
    maxResultSizeChars: 24_000,
    isReadOnlyAgent: true,
    omitProjectContext: false,
    getSystemPrompt: () => 'You are a security reviewer.',
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [...BUILT_IN_AGENT_DEFINITIONS, securityAgent],
  })

  assert.match(agentTool.description, /security-review/)
  assert.match(agentTool.description, /Adversarial security review/)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'check auth', subagent_type: 'security-review' }), true)

  const result = await agentTool.execute({ task: 'check auth', subagent_type: 'security-review' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'security report')
  assert.match(requests[0]!.system ?? '', /security reviewer/)
})

test('parallel custom read-only sub-agents receive isolated tool contexts', async () => {
  const requestsBySource = new Map<string, number>()
  const observedContexts: Array<{ sessionId: string; readFilesBefore: number }> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const seen = requestsBySource.get(request.cacheSource) ?? 0
      requestsBySource.set(request.cacheSource, seen + 1)
      if (seen === 0) {
        return {
          content: 'marking context',
          toolCalls: [{ id: `mark-${requestsBySource.size}`, name: 'markContext', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const markContextTool: Tool = {
    name: 'markContext',
    description: 'record sub-agent context isolation',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, context) {
      observedContexts.push({
        sessionId: context.sessionId,
        readFilesBefore: context.readFiles.size,
      })
      context.readFiles.add(`file-for-${context.sessionId}`)
      return { ok: true, content: 'marked' }
    },
  }
  const agentDefinitions = [
    ...BUILT_IN_AGENT_DEFINITIONS,
    {
      type: 'custom-a',
      description: 'Custom read-only agent A.',
      tools: ['markContext'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'custom a',
    },
    {
      type: 'custom-b',
      description: 'Custom read-only agent B.',
      tools: ['markContext'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'custom b',
    },
  ]
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [markContextTool],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions,
  })

  const [a, b] = await Promise.all([
    agentTool.execute({ task: 'a', subagent_type: 'custom-a' }, toolContext('parent')),
    agentTool.execute({ task: 'b', subagent_type: 'custom-b' }, toolContext('parent')),
  ])

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(observedContexts.length, 2)
  assert.equal(new Set(observedContexts.map((item) => item.sessionId)).size, 2)
  assert.deepEqual(observedContexts.map((item) => item.readFilesBefore), [0, 0])
})

test('Agent tool reports a clear runtime error for unknown custom subagent types', async () => {
  const agentTool = createAgentTool({
    provider: {
      name: 'fake',
      async createMessage() {
        return { content: 'unused', toolCalls: [] }
      },
    },
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })

  const result = await agentTool.execute({ task: 'hello', subagent_type: 'missing-agent' }, toolContext())

  assert.equal(result.ok, false)
  assert.match(result.content, /Unknown subagent_type "missing-agent"/)
  assert.match(result.content, /general, fork, explore, plan/)
})

test('custom agent maxResultSizeChars controls its result budget', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'x'.repeat(100), toolCalls: [] }
    },
  }
  const tinyAgent = {
    type: 'tiny',
    description: 'Tiny reports.',
    tools: ['Read'],
    disallowedTools: ['Agent'],
    maxTurns: 2,
    maxResultSizeChars: 12,
    isReadOnlyAgent: true,
    getSystemPrompt: () => 'Keep it tiny.',
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [readOnlyTool('Read')],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [...BUILT_IN_AGENT_DEFINITIONS, tinyAgent],
  })

  const result = await agentTool.execute({ task: 'short report', subagent_type: 'tiny' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content.slice(0, 12), 'x'.repeat(12))
  assert.match(result.content, /Tool result truncated: exceeded 12 chars; original 100 chars/)
})

test('custom agent only receives Bash when frontmatter explicitly lists it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  try {
    const agentsDir = path.join(root, 'project', '.myagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(path.join(agentsDir, 'readonly.md'), agentFile({
      name: 'readonly',
      description: 'Read-only wildcard.',
      tools: ['*'],
      body: 'readonly prompt',
    }))
    await writeFile(path.join(agentsDir, 'runner.md'), agentFile({
      name: 'runner',
      description: 'Can run commands.',
      tools: ['Glob', 'Grep', 'Read', 'Bash'],
      body: 'runner prompt',
    }))

    const definitions = await new AgentDefinitionLoader(path.join(root, 'project'), path.join(root, 'home')).list()
    const readonly = definitions.find((definition) => definition.type === 'readonly')
    const runner = definitions.find((definition) => definition.type === 'runner')
    const tools = [readOnlyTool('Glob'), readOnlyTool('Grep'), readOnlyTool('Read'), safeTool('Bash')]

    assert.ok(readonly)
    assert.ok(runner)
    assert.deepEqual(filterToolsForSubAgent(tools, readonly).map((tool) => tool.name), ['Glob', 'Grep', 'Read'])
    assert.deepEqual(filterToolsForSubAgent(tools, runner).map((tool) => tool.name), ['Glob', 'Grep', 'Read', 'Bash'])
    assert.equal(readonly.isReadOnlyAgent, true)
    assert.equal(runner.isReadOnlyAgent, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('custom agent read-only inference treats write-like tools as non-concurrency-safe', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  try {
    const agentsDir = path.join(root, 'project', '.myagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(path.join(agentsDir, 'writer.md'), agentFile({
      name: 'writer',
      description: 'Can write files.',
      tools: ['Glob', 'Grep', 'Read', 'Write'],
      body: 'writer prompt',
    }))
    await writeFile(path.join(agentsDir, 'opaque.md'), agentFile({
      name: 'opaque',
      description: 'Explicitly side-effecting external reviewer.',
      tools: ['Glob', 'Grep', 'Read'],
      isReadOnlyAgent: false,
      body: 'opaque prompt',
    }))

    const definitions = await new AgentDefinitionLoader(path.join(root, 'project'), path.join(root, 'home')).list()
    const writer = definitions.find((definition) => definition.type === 'writer')
    const opaque = definitions.find((definition) => definition.type === 'opaque')

    assert.ok(writer)
    assert.ok(opaque)
    assert.equal(writer.isReadOnlyAgent, false)
    assert.equal(opaque.isReadOnlyAgent, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AgentDefinitionLoader warns for risky custom agent definitions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const agentsDir = path.join(root, 'project', '.myagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(path.join(agentsDir, 'explore.md'), agentFile({
      name: 'explore',
      description: 'Overrides built-in explore.',
      body: 'custom explore prompt',
    }))
    await writeFile(path.join(agentsDir, 'unsafe.md'), agentFile({
      name: 'unsafe',
      description: 'Incorrectly claims read-only.',
      tools: ['Glob', 'Bash', 'Delete'],
      isReadOnlyAgent: true,
      body: 'unsafe prompt',
    }))
    await writeFile(path.join(agentsDir, 'verbose.md'), agentFile({
      name: 'verbose',
      description: 'Very large prompt.',
      body: 'x'.repeat(16_001),
    }))

    const definitions = await new AgentDefinitionLoader(path.join(root, 'project'), path.join(root, 'home')).list()
    const unsafe = definitions.find((definition) => definition.type === 'unsafe')

    assert.ok(unsafe)
    assert.equal(unsafe.isReadOnlyAgent, false)
    assert.ok(warnings.some((warning) => warning.includes("Custom agent 'explore' overrides built-in definition")))
    assert.ok(warnings.some((warning) => warning.includes("Custom agent 'unsafe' declares isReadOnlyAgent: true but lists write-like tools")))
    assert.ok(warnings.some((warning) => warning.includes("Custom agent 'verbose' system prompt is 16001 chars")))
  } finally {
    console.warn = originalWarn
    await rm(root, { recursive: true, force: true })
  }
})

// ============================================================================
// Phase 1: Differentiated Turn Limits
// ============================================================================

test('fork agent default maxTurns is 200', () => {
  const fork = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'fork')
  assert.ok(fork)
  assert.equal(fork.maxTurns, 200)
})

test('general agent default maxTurns is 30', () => {
  const general = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'general')
  assert.ok(general)
  assert.equal(general.maxTurns, 30)
})

test('explore agent default maxTurns is 30', () => {
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')
  assert.ok(explore)
  assert.equal(explore.maxTurns, 30)
})

test('plan agent default maxTurns is 30', () => {
  const plan = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')
  assert.ok(plan)
  assert.equal(plan.maxTurns, 30)
})

test('explicit maxTurns in input overrides per-type default', async () => {
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

  const result = await agentTool.execute({
    task: 'loop',
    subagent_type: 'fork',
    maxTurns: 2,
  }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(requests, 2)
  assert.match(result.content, /Sub-agent output may be incomplete: reached max turns limit \(2\)/)
})

// ============================================================================
// Phase 1: Expanded Tool Restrictions
// ============================================================================

test('ALL_AGENT_DISALLOWED_TOOLS contains expected tools', async () => {
  const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../src/tools/AgentTool/AgentTool.js')
  assert.ok(ALL_AGENT_DISALLOWED_TOOLS.includes('Agent'))
  assert.ok(ALL_AGENT_DISALLOWED_TOOLS.includes('EnterPlanMode'))
  assert.ok(ALL_AGENT_DISALLOWED_TOOLS.includes('ExitPlanMode'))
  assert.ok(ALL_AGENT_DISALLOWED_TOOLS.includes('AskUserQuestion'))
  assert.ok(ALL_AGENT_DISALLOWED_TOOLS.includes('SendMessage'))
})

test('built-in explore keeps Bash read-only even when the parent is in bypass mode', async () => {
  let runs = 0
  let prompts = 0
  const commands = ['git status', 'touch marker']
  let execution = 0
  let modelCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      modelCalls++
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done', toolCalls: [] }
      }
      return { content: '', toolCalls: [{ id: `bash-${execution}`, name: 'Bash', input: { command: commands[execution] } }] }
    },
  }
  const bash: Tool = {
    name: 'Bash',
    description: 'shell',
    riskLevel: 'dangerous',
    isDestructive: true,
    inputSchema: z.object({ command: z.string() }).strict(),
    async execute() {
      runs++
      return { ok: true, content: 'ran' }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [bash],
    permissionPrompt: async () => {
      prompts++
      return true
    },
    permissionMode: () => 'bypass',
    cwd: process.cwd(),
  })

  assert.equal((await agentTool.execute({ task: 'inspect', subagent_type: 'explore' }, toolContext())).ok, true)
  assert.equal(runs, 1)

  execution = 1
  assert.equal((await agentTool.execute({
    task: 'try write',
    subagent_type: 'explore',
    run_in_background: true,
  }, toolContext())).ok, true)
  await waitFor(() => modelCalls >= 4)
  assert.equal(runs, 1)
  assert.equal(prompts, 0)
})

test('ASYNC_AGENT_ALLOWED_TOOLS contains expected tools', async () => {
  const { ASYNC_AGENT_ALLOWED_TOOLS } = await import('../src/tools/AgentTool/AgentTool.js')
  const allowed = ASYNC_AGENT_ALLOWED_TOOLS as readonly string[]
  assert.ok(allowed.includes('Read'))
  assert.ok(allowed.includes('Glob'))
  assert.ok(allowed.includes('Grep'))
  assert.ok(allowed.includes('Bash'))
  assert.ok(allowed.includes('Write'))
  assert.ok(allowed.includes('Edit'))
  assert.ok(allowed.includes('MultiEdit'))
  assert.ok(allowed.includes('Delete'))
  assert.ok(allowed.includes('Skill'))
  // Tools that should NOT be in async whitelist
  assert.ok(!allowed.includes('TaskCreate'))
  assert.ok(!allowed.includes('TaskList'))
  assert.ok(!allowed.includes('Agent'))
})

test('background agents only receive tools from ASYNC_AGENT_ALLOWED_TOOLS', () => {
  const tools = [
    readOnlyTool('Read'),
    readOnlyTool('Glob'),
    readOnlyTool('Grep'),
    safeTool('Bash'),
    safeTool('Write'),
    readOnlyTool('Agent'),
    readOnlyTool('Workflow'),
    readOnlyTool('CustomTool'),
  ]
  const definition = BUILT_IN_AGENT_DEFINITIONS.find((d) => d.type === 'general')!

  const filtered = filterToolsForSubAgent(tools, definition, { isBackground: true })

  assert.ok(filtered.every((t) => ['Read', 'Glob', 'Grep', 'Bash', 'Write'].includes(t.name)))
  assert.ok(!filtered.some((t) => t.name === 'Agent'))
  assert.ok(!filtered.some((t) => t.name === 'Workflow'))
  assert.ok(!filtered.some((t) => t.name === 'CustomTool'))
})

test('non-background agents are unaffected by async whitelist', () => {
  const tools = [
    readOnlyTool('Read'),
    readOnlyTool('Glob'),
    readOnlyTool('Grep'),
    safeTool('Bash'),
    readOnlyTool('Agent'),
  ]
  const definition = BUILT_IN_AGENT_DEFINITIONS.find((d) => d.type === 'general')!

  const filtered = filterToolsForSubAgent(tools, definition)

  assert.ok(filtered.some((t) => t.name === 'Read'))
  assert.ok(filtered.some((t) => t.name === 'Glob'))
  assert.ok(filtered.some((t) => t.name === 'Grep'))
  assert.ok(!filtered.some((t) => t.name === 'Agent'))
})

// ============================================================================
// Phase 1: Fork Recursion Prevention
// ============================================================================

test('fork agent rejects recursive fork when parent records contain fork boilerplate', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'unused', toolCalls: [] }
    },
  }
  const parentRecords: SessionRecord[] = [{
    type: 'message',
    id: 'fork-msg',
    role: 'user',
    content: '# Forked Conversation Context\n__HANEKAWA_FORK_AGENT__\nYou are running as an isolated fork.',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => parentRecords,
  })

  const result = await agentTool.execute({ task: 'recursive fork', subagent_type: 'fork' }, toolContext())

  assert.equal(result.ok, false)
  assert.match(result.content, /Recursive fork agent detected/)
})

test('fork agent succeeds when parent records do not contain fork boilerplate', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'fork result', toolCalls: [] }
    },
  }
  const parentRecords: SessionRecord[] = [{
    type: 'message',
    id: 'normal-msg',
    role: 'user',
    content: 'normal parent context',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => parentRecords,
  })

  const result = await agentTool.execute({ task: 'normal fork', subagent_type: 'fork' }, toolContext())

  assert.equal(result.ok, true)
  assert.equal(result.content, 'fork result')
})

// ============================================================================
// Phase 2: Async Agent Permission Avoidance
// ============================================================================

test('background agents use auto permission mode when parent mode is default', async () => {
  let promptCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'background done', toolCalls: [] }
    },
  }
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-perm-'))
  try {
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => {
        promptCalls += 1
        return false
      },
      permissionMode: () => 'default',
      cwd: root,
      agentDefinitions: [{
        type: 'bg-simple',
        description: 'Background simple agent.',
        background: true,
        disallowedTools: ['Agent'],
        maxTurns: 3,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'bg simple',
      }],
    })

    const parentRecords: SessionRecord[] = []
    const result = await agentTool.execute({
      task: 'run simple in background',
      subagent_type: 'bg-simple',
    }, {
      ...toolContext('parent-session'),
      appendRecord: async (record) => { parentRecords.push(record) },
    })

    assert.equal(result.ok, true)
    assert.match(result.content, /Started bg-simple sub-agent/)
    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
    assert.equal(promptCalls, 0, 'background agent should not prompt for permissions')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('background agents with explicit permissionMode honor their mode', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'background plan done', toolCalls: [] }
    },
  }
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-perm-explicit-'))
  try {
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => false,
      permissionMode: () => 'default',
      cwd: root,
      agentDefinitions: [{
        type: 'bg-plan',
        description: 'Background plan agent with explicit mode.',
        background: true,
        permissionMode: 'plan',
        disallowedTools: ['Agent'],
        maxTurns: 3,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'bg plan',
      }],
    })

    const parentRecords: SessionRecord[] = []
    const result = await agentTool.execute({
      task: 'run plan in background',
      subagent_type: 'bg-plan',
    }, {
      ...toolContext('parent-session'),
      appendRecord: async (record) => { parentRecords.push(record) },
    })

    assert.equal(result.ok, true)
    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parent bypass mode still takes precedence for background agents', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'background bypass done', toolCalls: [] }
    },
  }
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-bg-bypass-'))
  try {
    const agentTool = createAgentTool({
      provider,
      model: 'fake-model',
      tools: () => [],
      permissionPrompt: async () => false,
      permissionMode: () => 'bypass',
      cwd: root,
      agentDefinitions: [{
        type: 'bg-default',
        description: 'Background agent under bypass parent.',
        background: true,
        disallowedTools: ['Agent'],
        maxTurns: 3,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'bg default',
      }],
    })

    const parentRecords: SessionRecord[] = []
    const result = await agentTool.execute({
      task: 'run under bypass',
      subagent_type: 'bg-default',
    }, {
      ...toolContext('parent-session'),
      appendRecord: async (record) => { parentRecords.push(record) },
    })

    assert.equal(result.ok, true)
    await waitFor(() => parentRecords.some((record) => record.type === 'subagent_task' && record.status === 'completed'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ============================================================================
// Phase 2: Environment Variable Override for Subagent Model
// ============================================================================

test('MYAGENT_SUBAGENT_MODEL overrides default routing', async () => {
  const originalEnv = process.env.MYAGENT_SUBAGENT_MODEL
  try {
    process.env.MYAGENT_SUBAGENT_MODEL = 'fast-model'
    let requestedModelKey: string | undefined
    const routedProvider: ModelProvider = {
      name: 'routed',
      async createMessage() {
        return { content: 'env routed result', toolCalls: [] }
      },
    }
    const agentTool = createAgentTool({
      provider: {
        name: 'parent',
        async createMessage() {
          throw new Error('parent provider should not be used')
        },
      },
      model: 'parent-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: process.cwd(),
      resolveSubagentModel: (subagentType, modelKey) => {
        requestedModelKey = modelKey
        return {
          provider: routedProvider,
          model: 'fast-provider-model',
          modelKey,
          providerName: 'routed',
        }
      },
    })

    const result = await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext())

    assert.equal(result.ok, true)
    assert.equal(result.content, 'env routed result')
    assert.equal(requestedModelKey, 'fast-model')
  } finally {
    if (originalEnv === undefined) {
      delete process.env.MYAGENT_SUBAGENT_MODEL
    } else {
      process.env.MYAGENT_SUBAGENT_MODEL = originalEnv
    }
  }
})

test('MYAGENT_SUBAGENT_MODEL per-type override takes precedence', async () => {
  const originalGeneric = process.env.MYAGENT_SUBAGENT_MODEL
  const originalExplore = process.env.MYAGENT_SUBAGENT_MODEL_EXPLORE
  try {
    process.env.MYAGENT_SUBAGENT_MODEL = 'generic-model'
    process.env.MYAGENT_SUBAGENT_MODEL_EXPLORE = 'explore-specific-model'
    let requestedModelKey: string | undefined
    const routedProvider: ModelProvider = {
      name: 'routed',
      async createMessage() {
        return { content: 'per-type routed result', toolCalls: [] }
      },
    }
    const agentTool = createAgentTool({
      provider: {
        name: 'parent',
        async createMessage() {
          throw new Error('parent provider should not be used')
        },
      },
      model: 'parent-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: process.cwd(),
      resolveSubagentModel: (subagentType, modelKey) => {
        requestedModelKey = modelKey
        return {
          provider: routedProvider,
          model: 'explore-provider-model',
          modelKey,
          providerName: 'routed',
        }
      },
    })

    const result = await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext())

    assert.equal(result.ok, true)
    assert.equal(requestedModelKey, 'explore-specific-model')
  } finally {
    if (originalGeneric === undefined) {
      delete process.env.MYAGENT_SUBAGENT_MODEL
    } else {
      process.env.MYAGENT_SUBAGENT_MODEL = originalGeneric
    }
    if (originalExplore === undefined) {
      delete process.env.MYAGENT_SUBAGENT_MODEL_EXPLORE
    } else {
      process.env.MYAGENT_SUBAGENT_MODEL_EXPLORE = originalExplore
    }
  }
})

test('invalid MYAGENT_SUBAGENT_MODEL falls through to default routing', async () => {
  const originalEnv = process.env.MYAGENT_SUBAGENT_MODEL
  try {
    process.env.MYAGENT_SUBAGENT_MODEL = 'nonexistent-model'
    const provider: ModelProvider = {
      name: 'parent',
      async createMessage() {
        return { content: 'fallback result', toolCalls: [] }
      },
    }
    const agentTool = createAgentTool({
      provider,
      model: 'parent-model',
      tools: () => [],
      permissionPrompt: async () => true,
      cwd: process.cwd(),
      resolveSubagentModel: () => undefined,
    })

    const result = await agentTool.execute({ task: 'map files', subagent_type: 'explore' }, toolContext())

    assert.equal(result.ok, true)
    assert.equal(result.content, 'fallback result')
  } finally {
    if (originalEnv === undefined) {
      delete process.env.MYAGENT_SUBAGENT_MODEL
    } else {
      process.env.MYAGENT_SUBAGENT_MODEL = originalEnv
    }
  }
})

// ============================================================================
// Phase 3: CriticalSystemReminder in Custom Agents
// ============================================================================

test('AgentDefinitionLoader parses criticalSystemReminder from frontmatter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-agents-'))
  const cwd = path.join(root, 'project')
  try {
    await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
    await writeFile(path.join(cwd, '.myagent', 'agents', 'reminder.md'), agentFile({
      name: 'reminder-agent',
      description: 'Agent with critical reminder.',
      body: 'You are a reminder agent.',
      criticalSystemReminder: 'Stay focused on the task.',
    }))

    const definitions = await new AgentDefinitionLoader(cwd, path.join(root, 'home')).list()
    const definition = definitions.find((item) => item.type === 'reminder-agent')

    assert.ok(definition)
    assert.equal(definition.criticalSystemReminder, 'Stay focused on the task.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('custom agent criticalSystemReminder is injected into sub-agent system prompts', async () => {
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
    agentDefinitions: [{
      type: 'reminded',
      description: 'Agent with critical reminder.',
      tools: ['Read'],
      disallowedTools: ['Agent'],
      maxTurns: 1,
      isReadOnlyAgent: true,
      criticalSystemReminder: 'Always verify your findings.',
      getSystemPrompt: () => 'You are a reminded agent.',
    }],
  })

  await agentTool.execute({ task: 'verify', subagent_type: 'reminded' }, toolContext())

  assert.equal(requests.length, 1)
  assert.match(requests[0]!.system ?? '', /Always verify your findings/)
  assert.ok(requests[0]!.systemBlocks?.some((block) => /Always verify your findings/.test(block)))
})

function agentFile(options: {
  name: string
  description: string
  model?: string
  permissionMode?: string
  skills?: string[]
  mcpServers?: string[]
  background?: boolean
  isolation?: string
  tools?: string[]
  isReadOnlyAgent?: boolean
  maxTurns?: number
  criticalSystemReminder?: string
  body: string
}): string {
  const model = options.model ? `model: ${options.model}\n` : ''
  const permissionMode = options.permissionMode ? `permissionMode: ${options.permissionMode}\n` : ''
  const skills = options.skills ? `skills: ${JSON.stringify(options.skills)}\n` : ''
  const mcpServers = options.mcpServers ? `mcpServers: ${JSON.stringify(options.mcpServers)}\n` : ''
  const background = options.background === undefined ? '' : `background: ${options.background}\n`
  const isolation = options.isolation ? `isolation: ${options.isolation}\n` : ''
  const tools = options.tools ? `tools: ${JSON.stringify(options.tools)}\n` : ''
  const isReadOnlyAgent = options.isReadOnlyAgent === undefined ? '' : `isReadOnlyAgent: ${options.isReadOnlyAgent}\n`
  const maxTurns = options.maxTurns === undefined ? '' : `maxTurns: ${options.maxTurns}\n`
  const criticalSystemReminder = options.criticalSystemReminder ? `criticalSystemReminder: ${options.criticalSystemReminder}\n` : ''
  return [
    '---',
    `name: ${options.name}`,
    `description: ${options.description}`,
    model.trimEnd(),
    permissionMode.trimEnd(),
    skills.trimEnd(),
    mcpServers.trimEnd(),
    background.trimEnd(),
    isolation.trimEnd(),
    tools.trimEnd(),
    isReadOnlyAgent.trimEnd(),
    maxTurns.trimEnd(),
    criticalSystemReminder.trimEnd(),
    '---',
    options.body,
    '',
  ].filter((line) => line !== '').join('\n')
}

/**
 * S23 — attachment ownership across the subagent boundary (design §12.3).
 *
 * A subagent's tool context carries the *agent* id as its `sessionId`, which is
 * what keeps its read state isolated. Left unpinned, every image it imported
 * would be filed under that id: a directory no session owns, that
 * `deleteSessionArtifacts` never reaches and `/resume` never rebuilds.
 */

function attachmentRef(overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id: 'img-parent-1',
    ownerSessionId: 'parent-session',
    name: 'screenshot.png',
    mimeType: 'image/png',
    width: 20,
    height: 10,
    byteLength: 64,
    ...overrides,
  }
}

/** A store that only records who it was asked to file images under. */
function recordingImageStore(imports: Array<{ owner: string; name: string }>): ImageAttachmentImporter {
  return {
    async importImage(owner, _bytes, name) {
      imports.push({ owner, name })
      const ref = attachmentRef({ id: `img-${imports.length}`, ownerSessionId: owner, name })
      return {
        ok: true,
        value: {
          ref,
          metadata: {
            originalWidth: ref.width,
            originalHeight: ref.height,
            sentWidth: ref.width,
            sentHeight: ref.height,
            localPath: `/tmp/${name}`,
          },
          animated: false,
        },
      }
    },
  }
}

test('sub-agent imported images are owned by the parent session, not by the agent id', async () => {
  const imports: Array<{ owner: string; name: string }> = []
  const seenSessionIds: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done', toolCalls: [] }
      }
      return { content: 'reading', toolCalls: [{ id: 'call-1', name: 'importImage', input: {} }] }
    },
  }
  const importTool: Tool = {
    name: 'importImage',
    description: 'stands in for the Read tool image branch',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    async execute(_input, context) {
      seenSessionIds.push(context.sessionId)
      assert.ok(context.imageAttachments, 'sub-agent context should carry an attachment handle')
      // The Read tool passes its own `context.sessionId`; the pin must win.
      const stored = await context.imageAttachments.importImage(
        context.sessionId,
        Buffer.from('png'),
        'shot.png',
      )
      assert.equal(stored.ok, true)
      return { ok: true, content: 'imported' }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [importTool],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    imageAttachments: recordingImageStore(imports),
    agentDefinitions: [...BUILT_IN_AGENT_DEFINITIONS, {
      type: 'reader',
      description: 'Imports one image.',
      tools: ['importImage'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'reader',
    }],
  })

  const result = await agentTool.execute({ task: 'read it', subagent_type: 'reader' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  // Isolated context, parent-owned files: both halves of design §12.3.
  assert.deepEqual(seenSessionIds.map((id) => id === 'parent-session'), [false])
  assert.deepEqual(imports, [{ owner: 'parent-session', name: 'shot.png' }])
})

test('a sub-agent without an attachment store keeps no handle at all', async () => {
  let handle: unknown = 'unset'
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.contextItems?.some((item) => item.kind === 'tool_result')) {
        return { content: 'done', toolCalls: [] }
      }
      return { content: 'peeking', toolCalls: [{ id: 'call-1', name: 'peek', input: {} }] }
    },
  }
  const peekTool: Tool = {
    name: 'peek',
    description: 'reports whether an attachment handle exists',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    async execute(_input, context) {
      handle = context.imageAttachments
      return { ok: true, content: 'peeked' }
    },
  }
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [peekTool],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    agentDefinitions: [...BUILT_IN_AGENT_DEFINITIONS, {
      type: 'peeker',
      description: 'Peeks at its context.',
      tools: ['peek'],
      disallowedTools: ['Agent'],
      maxTurns: 3,
      isReadOnlyAgent: true,
      getSystemPrompt: () => 'peeker',
    }],
  })

  await agentTool.execute({ task: 'peek', subagent_type: 'peeker' }, toolContext('parent-session'))

  // Not a store bound to some other session: nothing, so the Read tool answers
  // with `attachment-store-unavailable` rather than reaching for pixels.
  assert.equal(handle, undefined)
})

test('a fork sub-agent resolves inherited image refs and only those', async () => {
  const requests: ModelRequest[] = []
  const asked: string[] = []
  const inherited = attachmentRef()
  const foreign = attachmentRef({ id: 'img-elsewhere', ownerSessionId: 'other-session', name: 'other.png' })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const parentRecords: SessionRecord[] = [{
    type: 'message',
    id: 'parent-1',
    role: 'user',
    content: 'here is a screenshot',
    images: [inherited, foreign],
    createdAt: '2026-09-09T00:00:00.000Z',
  }]
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    supportsImageInput: true,
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => parentRecords,
    // Registered refs resolve; anything else is a per-image miss, which is the
    // whole of the "only through registered exact references" rule.
    attachmentBytes: {
      async readSendBytes(ref) {
        asked.push(`${ref.ownerSessionId}/${ref.id}`)
        if (ref.ownerSessionId === 'parent-session' && ref.id === inherited.id) {
          return { ok: true, value: { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' } }
        }
        return { ok: false, reason: 'file-missing', message: 'not registered here' }
      },
    },
  })

  const result = await agentTool.execute({ task: 'continue', subagent_type: 'fork' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.deepEqual(asked.sort(), ['other-session/img-elsewhere', 'parent-session/img-parent-1'])
  assert.deepEqual([...(requests[0]?.imageBytes?.keys() ?? [])], [inherited.id])
})

test('a text-only fork sub-agent degrades inherited images without asking the parent', async () => {
  const requests: ModelRequest[] = []
  let bytesRequested = 0
  const inherited = attachmentRef()
  const childProvider: ModelProvider = {
    name: 'child',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const agentTool = createAgentTool({
    provider: {
      name: 'parent',
      async createMessage() {
        throw new Error('the parent provider must not serve the sub-agent')
      },
    },
    model: 'parent-model',
    // The parent sees images; the child's own model does not. The child has to
    // decide on its own capability, never on this conclusion.
    supportsImageInput: true,
    tools: () => [],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    loadParentRecords: async () => [{
      type: 'message',
      id: 'parent-1',
      role: 'user',
      content: 'here is a screenshot',
      images: [inherited],
      createdAt: '2026-09-09T00:00:00.000Z',
    }],
    resolveSubagentModel: () => ({
      provider: childProvider,
      model: 'text-only-model',
      modelKey: 'text-only',
      providerName: 'child',
      supportsImageInput: false,
    }),
    attachmentBytes: {
      async readSendBytes() {
        bytesRequested += 1
        return { ok: true, value: { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' } }
      },
    },
  })

  const result = await agentTool.execute({ task: 'continue', subagent_type: 'fork' }, toolContext('parent-session'))

  assert.equal(result.ok, true)
  assert.equal(bytesRequested, 0, 'a text-only child must not load image bytes')
  assert.equal(requests[0]?.imageBytes, undefined)
  const preloaded = requests[0]?.contextItems?.find(
    (item) => item.kind === 'message' && item.message.id === 'parent-1',
  )
  assert.ok(preloaded && preloaded.kind === 'message')
  assert.equal(preloaded.message.images, undefined)
  assert.match(preloaded.message.content, /screenshot\.png/)
})
