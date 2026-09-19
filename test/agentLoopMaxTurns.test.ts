import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, SessionRecord, Tool } from '../src/harness/types.js'

function recordStreamFor(records: SessionRecord[]): RecordStream {
  return {
    load: async () => records,
    append: async (record) => { records.push(record) },
    update: async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      const record = records[index]
      if (!record) return
      records[index] = update(record)
    },
  }
}

const noopTool: Tool = {
  name: 'noop',
  description: 'noop',
  inputSchema: z.object({}).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  async execute() {
    return { ok: true, content: 'ok' }
  },
}

function loopFor(provider: ModelProvider, records: SessionRecord[], options: Record<string, unknown> = {}) {
  const tools = [noopTool]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  return new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    ...options,
  })
}

test('main session without maxTurns runs past the old 100-turn cap', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      if (calls > 150) return { content: 'done', toolCalls: [] }
      return { content: 'keep going', toolCalls: [{ id: `noop-${calls}`, name: 'noop', input: {} }] }
    },
  }

  const response = await loopFor(provider, records).run({ text: 'hello' })

  assert.equal(calls, 151)
  assert.equal(response.content, 'done')
})

test('repeated max_tokens still stops at the recovery limit without a turn cap', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: `chunk ${calls}`, toolCalls: [], stopReason: 'max_tokens' as const }
    },
  }

  const response = await loopFor(provider, records).run({ text: 'hello' })

  // One escalation retry plus MAX_RECOVERY_COUNT (3) continuations, then stop.
  assert.equal(calls, 5)
  assert.equal(response.stopReason, 'max_tokens')
})

test('sub-agent maxTurns still finishes partial at the limit', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: `turn ${calls}`, toolCalls: [{ id: `noop-${calls}`, name: 'noop', input: {} }] }
    },
  }

  const response = await loopFor(provider, records, {
    maxTurns: 3,
    maxTurnsExceededBehavior: 'partial',
  }).run({ text: 'hello' })

  assert.equal(calls, 3)
  assert.equal(response.stopReason, 'max_turns')
  assert.match(response.content, /turn 3/)
  assert.match(response.content, /reached max turns limit \(3\)/)
})
