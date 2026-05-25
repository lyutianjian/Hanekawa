import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { BUILT_IN_AGENT_DEFINITIONS, createAgentTool, filterToolsForSubAgent } from '../src/tools/agentTool.js'
import { AgentDefinitionLoader } from '../src/services/agents/agentDefinitionLoader.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate } from '../src/harness/permissions.js'
import type { ModelProvider, ModelRequest, SessionRecord, Tool, ToolContext } from '../src/harness/types.js'

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
    readOnlyTool('Bash'),
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
    readOnlyTool('TodoWrite'),
    safeTool('Bash'),
    safeTool('Write'),
  ]
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')
  const verification = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'verification')

  assert.ok(explore)
  assert.ok(verification)
  assert.deepEqual(filterToolsForSubAgent(tools, explore).map((tool) => tool.name), ['Glob', 'Grep', 'Read'])
  assert.deepEqual(filterToolsForSubAgent(tools, verification).map((tool) => tool.name), ['Glob', 'Grep', 'Read', 'Bash'])
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
  assert.equal(BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'verification')?.isReadOnlyAgent, false)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'research', subagent_type: 'general' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'map', subagent_type: 'explore' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'design', subagent_type: 'plan' }), true)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'verify', subagent_type: 'verification' }), false)
  assert.equal(agentTool.isConcurrencySafeInput?.({ task: 'missing type' }), false)
})

test('Agent tool keeps sub-agent records out of the parent record stream', async () => {
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
  assert.deepEqual(parentRecords.map((record) => record.type), ['tool_use', 'tool_approval', 'tool_result', 'message'])
  const summary = parentRecords.at(-1)
  assert.ok(summary && summary.type === 'message')
  assert.equal(summary.role, 'assistant')
  assert.match(summary.content, /<subagent-summary type="general"/)
  assert.match(summary.content, /tokens="15"/)
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
  assert.deepEqual(subagent.usage, { inputTokens: 100, cacheReadInputTokens: 20, outputTokens: 30 })
  assert.equal(subagent.verdict, 'PASS')
  assert.deepEqual(subagent.criticalFiles, ['src/tools/agentTool.ts', 'test/agentTool.test.ts'])
})

test('verification Agent result emits a structured subagent summary in the parent stream', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: 'Checked the changed path.\nVERDICT: PASS',
        toolCalls: [],
        usage: { inputTokens: 12, cacheReadInputTokens: 3, outputTokens: 4 },
      }
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
    id: 'verify-1',
    name: 'Agent',
    input: { task: 'verify last change', subagent_type: 'verification' },
  }, toolContext('parent-session'), undefined, 'turn-1')

  assert.equal(result.ok, true)
  assert.match(result.content, /VERDICT: PASS/)
  const summary = records.find((record) => record.type === 'message' && record.role === 'assistant')
  assert.ok(summary && summary.type === 'message')
  assert.equal(summary.turnId, 'turn-1')
  assert.match(summary.content, /^<subagent-summary /)
  assert.match(summary.content, /type="verification"/)
  assert.match(summary.content, /verdict="PASS"/)
  assert.match(summary.content, /tokens="19"/)
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
  assert.notEqual(requests[0]!.cacheSource, 'agent:parent-session')
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
          matcher: 'verification',
          command: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
        },
        {
          matcher: 'verification',
          command: `${JSON.stringify(process.execPath)} -e "console.log('__HANEKAWA_HOOK__'); console.log('{\\"blockingError\\":\\"stop blocked\\"}'); process.exit(1)"`,
        },
      ],
    },
  })

  const result = await agentTool.execute({ task: 'verify', subagent_type: 'verification' }, toolContext('parent-session'))

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

  const result = await agentTool.execute({ task: 'loop', subagent_type: 'general', maxTurns: 1 }, toolContext())

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

test('verification agent prompt names overconfidence traps and requires command evidence', async () => {
  const verification = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'verification')

  assert.ok(verification)
  const prompt = verification.getSystemPrompt()
  assert.match(prompt ?? '', /verification avoidance/)
  assert.match(prompt ?? '', /being seduced by the first 80%/)
  assert.match(prompt ?? '', /RECOGNIZE YOUR OWN RATIONALIZATIONS/)
  assert.match(prompt ?? '', /Command run/)
  assert.match(prompt ?? '', /under ~800 words/)
  assert.match(prompt ?? '', /VERDICT: PARTIAL/)
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
  assert.match(agentTool.description, /When NOT to use the Agent tool/)
  assert.match(agentTool.description, /smart colleague who just walked into the room/)
  assert.match(agentTool.description, /Never delegate understanding/)
  assert.match(agentTool.description, /based on your findings, fix the bug/)
  assert.match(agentTool.description, /Always pass an explicit subagent_type/)
})

test('explore agent prompt enforces read-only fact finding', async () => {
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')

  assert.ok(explore)
  const prompt = explore.getSystemPrompt()
  assert.match(prompt ?? '', /CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS/)
  assert.match(prompt ?? '', /Creating new files/)
  assert.match(prompt ?? '', /Moving or copying files/)
  assert.match(prompt ?? '', /only have Glob, Grep, and Read/)
  assert.match(prompt ?? '', /Prefer parallel read-only searches/)
  assert.match(prompt ?? '', /file paths and line numbers/)
  assert.match(prompt ?? '', /high-signal findings/)
})

test('plan agent prompt defines read-only architecture planning process', async () => {
  const plan = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')

  assert.ok(plan)
  const prompt = plan.getSystemPrompt()
  assert.match(prompt ?? '', /CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS/)
  assert.match(prompt ?? '', /only have Glob, Grep, and Read/)
  assert.match(prompt ?? '', /Understand Requirements/)
  assert.match(prompt ?? '', /Explore Thoroughly/)
  assert.match(prompt ?? '', /Design Solution/)
  assert.match(prompt ?? '', /Detail the Plan/)
  assert.match(prompt ?? '', /fit the plan to the current architecture/)
  assert.match(prompt ?? '', /Critical Files for Implementation/)
  assert.match(prompt ?? '', /3-5 files/)
})

test('specialist agent prompts require concise final reports', async () => {
  const explore = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'explore')
  const plan = BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === 'plan')

  assert.ok(explore)
  assert.ok(plan)
  assert.match(explore.getSystemPrompt() ?? '', /under ~500 words/)
  assert.match(plan.getSystemPrompt() ?? '', /under ~500 words/)
})

test('Agent loop can run verification through Agent tool directly', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'VERDICT: PASS', toolCalls: [] }
    },
  }
  let agentTool: Tool
  agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => [agentTool],
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })
  const runnerRecords: SessionRecord[] = []
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { runnerRecords.push(record) },
  })
  const { AgentLoop } = await import('../src/harness/loop.js')
  const { ContextBuilder } = await import('../src/harness/contextBuilder.js')
  const mainStreamRecords: SessionRecord[] = []
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: toolContext(),
    recordStream: {
      async append(record) { mainStreamRecords.push(record) },
      async load() {
        return []
      },
    },
  })

  const result = await loop.runTool({
    id: 'verify-1',
    name: 'Agent',
    input: { task: 'verify last turn', subagent_type: 'verification' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.content, 'VERDICT: PASS')
  assert.equal(requests.length, 1)
  assert.match(requests[0]!.system ?? '', /verification specialist/)
  // runTool must keep its records out of the main session stream and out of
  // the originally-injected ToolRunner sink.
  assert.deepEqual(mainStreamRecords, [], 'runTool leaked records into the main session stream')
  assert.deepEqual(runnerRecords, [], 'runTool leaked records through the original ToolRunner sink')
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
  assert.match(result.content, /general, explore, plan, verification/)
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

function agentFile(options: {
  name: string
  description: string
  tools?: string[]
  body: string
}): string {
  const tools = options.tools ? `tools: ${JSON.stringify(options.tools)}\n` : ''
  return [
    '---',
    `name: ${options.name}`,
    `description: ${options.description}`,
    tools.trimEnd(),
    '---',
    options.body,
    '',
  ].filter((line) => line !== '').join('\n')
}
