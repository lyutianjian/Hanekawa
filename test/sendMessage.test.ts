import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { createAgentTool } from '../src/tools/AgentTool/AgentTool.js'
import { createSendMessageTool } from '../src/tools/SendMessageTool/SendMessageTool.js'
import { BackgroundTaskRegistry, MAX_RETAINED_AGENT_CONTINUATIONS } from '../src/services/backgroundTasks/registry.js'
import { getBuiltinTools } from '../src/tools/index.js'
import type { ModelProvider, ModelRequest, SessionRecord, Tool, ToolContext } from '../src/harness/types.js'

function context(sessionId = 'parent', records: SessionRecord[] = []): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId,
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    appendRecord: async (record) => { records.push(record) },
  }
}

test('SendMessage resumes a completed explore agent with its prior context', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: requests.length === 1 ? 'first finding' : 'follow-up finding', toolCalls: [] }
    },
  }
  const registry = new BackgroundTaskRegistry()
  const parentRecords: SessionRecord[] = []
  let tools: Tool[] = []
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => tools,
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    backgroundTasks: registry,
  })
  const sendMessage = createSendMessageTool(registry)
  tools = [agentTool, sendMessage]

  const first = await agentTool.execute(
    { task: 'inspect the target', subagent_type: 'explore' },
    { ...context('parent', parentRecords), currentToolUseId: 'agent-call', currentTurnId: 'turn-1' },
  )
  assert.equal(first.ok, true)
  assert.match(first.content, /Agent ID: explore-1/)

  const second = await sendMessage.execute(
    { agent_id: 'explore-1', message: 'check the related tests too' },
    { ...context('parent', parentRecords), currentToolUseId: 'send-call', currentTurnId: 'turn-2' },
  )
  assert.equal(second.ok, true)
  assert.match(second.content, /follow-up finding/)
  assert.ok(requests[1]?.messages.some((message) => message.role === 'assistant' && message.content === 'first finding'))
  assert.ok(requests[1]?.messages.some((message) => message.role === 'user' && message.content === 'check the related tests too'))
  const transcripts = parentRecords.filter((record) => record.type === 'subagent_transcript')
  assert.equal(transcripts.length, 2)
  assert.ok(transcripts.every((record) => record.agentId === 'explore-1'))
  assert.equal(transcripts[1]?.parentToolUseId, 'send-call')
  // A resumed turn records and reports exactly what a first run does.
  assert.deepEqual(Object.keys(transcripts[1]!).sort(), Object.keys(transcripts[0]!).sort())
  assert.deepEqual(Object.keys(second.metadata?.subagent ?? {}).sort(), Object.keys(first.metadata?.subagent ?? {}).sort())
  assert.equal(typeof (second.metadata?.subagent as { durationMs?: unknown }).durationMs, 'number')
  // Counted per turn: the second holds only its own records.
  assert.ok(transcripts[1]!.type === 'subagent_transcript' && transcripts[1].messageCount === 2)
})

test('SendMessage is builtin and filtered from sub-agent tool sets', () => {
  const tools = getBuiltinTools(new BackgroundTaskRegistry())
  assert.ok(tools.some((tool) => tool.name === 'SendMessage'))
})

test('SendMessage queues running agent messages in FIFO order', async () => {
  const registry = new BackgroundTaskRegistry()
  registry.registerAgent({
    sessionId: 'session-1',
    agentId: registry.allocateAgentId('session-1', 'explore'),
    agentType: 'explore',
    description: 'running agent',
  })
  const sendMessage = createSendMessageTool(registry)
  const first = await sendMessage.execute({ agent_id: 'explore-1', message: 'one' }, context('session-1'))
  const second = await sendMessage.execute({ agent_id: 'explore', message: 'two' }, context('session-1'))
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(registry.consumePendingAgentMessages('session-1', 'explore-1'), ['one', 'two'])
})

test('running background agents inject queued messages before their next model iteration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hanekawa-send-message-'))
  let releaseFirstRequest!: () => void
  const firstRequestGate = new Promise<void>((resolve) => { releaseFirstRequest = resolve })
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      if (requests.length === 1) {
        await firstRequestGate
        return {
          content: 'checking',
          toolCalls: [{ id: 'probe-1', name: 'Read', input: {} }],
        }
      }
      return { content: 'handled queued follow-up', toolCalls: [] }
    },
  }
  const probe: Tool = {
    name: 'Read',
    description: 'read-only probe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() { return { ok: true, content: 'probe result' } },
  }
  const registry = new BackgroundTaskRegistry()
  const records: SessionRecord[] = []
  let tools: Tool[] = []
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => tools,
    permissionPrompt: async () => true,
    cwd: root,
    backgroundTasks: registry,
  })
  const sendMessage = createSendMessageTool(registry)
  tools = [probe, agentTool, sendMessage]
  try {
    const started = await agentTool.execute(
      { task: 'start research', subagent_type: 'general', run_in_background: true },
      context('parent', records),
    )
    assert.match(started.content, /Agent ID: general-1/)
    const queued = await sendMessage.execute(
      { agent_id: 'general-1', message: 'also inspect the tests' },
      context('parent', records),
    )
    assert.match(queued.content, /queued/)
    releaseFirstRequest()
    await waitFor(() => requests.length === 2)
    assert.ok(requests[1]?.messages.some((message) =>
      message.role === 'user' && message.content.includes('also inspect the tests'),
    ))
    await waitFor(() => registry.getSnapshot('parent').some((task) =>
      task.agentId === 'general-1' && task.status === 'completed',
    ))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent continuation retention is bounded by LRU without deleting task snapshots', async () => {
  const registry = new BackgroundTaskRegistry()
  for (let index = 1; index <= MAX_RETAINED_AGENT_CONTINUATIONS + 1; index++) {
    const agentId = `explore-${index}`
    registry.registerAgent({ sessionId: 'session-1', agentId, agentType: 'explore', description: agentId })
    registry.setAgentContinuation('session-1', agentId, {
      resume: async () => ({ ok: true, content: agentId }),
    })
    registry.completeAgent('session-1', agentId, 'completed')
  }
  assert.equal(registry.getSnapshot('session-1').filter((task) => task.kind === 'agent').length, 9)
  await assert.rejects(
    registry.sendAgentMessage('session-1', 'explore-1', 'again', context('session-1')),
    /cannot be resumed/,
  )
  const retained = await registry.sendAgentMessage('session-1', 'explore-9', 'again', context('session-1'))
  assert.equal(retained.kind, 'resumed')
})

test('replies to messages queued while an agent ran reach the parent as notices', async () => {
  const registry = new BackgroundTaskRegistry()
  registry.registerAgent({ sessionId: 'session-1', agentId: 'general-1', agentType: 'general', description: 'bg' })
  const queued = await registry.sendAgentMessage('session-1', 'general-1', 'check tests too', context('session-1'))
  assert.equal(queued.kind, 'queued')
  registry.setAgentContinuation('session-1', 'general-1', {
    resume: async (message) => ({ ok: true, content: `answer to ${message}` }),
  })
  registry.completeAgent('session-1', 'general-1', 'completed')

  await waitFor(() => registry.getSnapshot('session-1').some((task) => task.status === 'completed'))
  const notices = registry.consumeParentNotifications('session-1')
  assert.equal(notices.length, 1)
  assert.match(notices[0]!, /^<system-reminder>\nSub-agent general-1 replied[\s\S]*answer to check tests too/)
  assert.deepEqual(registry.consumeParentNotifications('session-1'), [])
})

test('stopping an agent mid-reply returns a stop result, not an abort', async () => {
  const registry = new BackgroundTaskRegistry()
  registry.registerAgent({ sessionId: 'session-1', agentId: 'general-1', agentType: 'general', description: 'bg' })
  registry.setAgentContinuation('session-1', 'general-1', {
    resume: (_message, _context, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  registry.completeAgent('session-1', 'general-1', 'completed')

  const reply = registry.sendAgentMessage('session-1', 'general-1', 'go on', context('session-1'))
  await registry.stopAgent('session-1', 'general-1', 'Stopped by user')
  const delivery = await reply

  assert.equal(delivery.kind, 'resumed')
  assert.equal(delivery.kind === 'resumed' ? delivery.result.errorCode : undefined, 'execution_failed')
  assert.equal(registry.getSnapshot('session-1')[0]?.status, 'killed')
})

test('SendMessage rejects ambiguous prefixes and non-completed terminal agents', async () => {
  const registry = new BackgroundTaskRegistry()
  for (const agentId of ['explore-1', 'explore-2']) {
    registry.registerAgent({ sessionId: 'session-1', agentId, agentType: 'explore', description: agentId })
    registry.completeAgent('session-1', agentId, 'failed', 'failed')
  }
  await assert.rejects(
    registry.sendAgentMessage('session-1', 'explore-', 'again', context('session-1')),
    /Ambiguous sub-agent id/,
  )
  await assert.rejects(
    registry.sendAgentMessage('session-1', 'explore-1', 'again', context('session-1')),
    /cannot be resumed/,
  )
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
