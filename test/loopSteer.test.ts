import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, PersistedQueuedMessage, SessionRecord, SteerSource, Tool } from '../src/harness/types.js'

function recordStreamFor(records: SessionRecord[]): RecordStream {
  return {
    load: async () => records,
    append: async (record) => { records.push(record) },
  }
}

function queued(id: string, content: string): PersistedQueuedMessage {
  return { id, content, priority: 'next', createdAt: new Date().toISOString() }
}

function steerFrom(pending: PersistedQueuedMessage[]): SteerSource {
  return {
    pending: () => [...pending],
    consume: async (messageId) => {
      const index = pending.findIndex((message) => message.id === messageId)
      if (index >= 0) pending.splice(index, 1)
    },
  }
}

function loopFor(provider: ModelProvider, records: SessionRecord[], steer: SteerSource, onTool: () => void) {
  const tool: Tool = {
    name: 'noop',
    description: 'noop',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      onTool()
      return { ok: true, content: 'ok' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  return new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [tool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    steer,
  })
}

function userTexts(records: readonly SessionRecord[]): string[] {
  return records.flatMap((record) => record.type === 'message' && record.role === 'user' ? [record.content] : [])
}

test('a message sent mid-turn joins the turn at the next step', async () => {
  const records: SessionRecord[] = []
  const pending: PersistedQueuedMessage[] = []
  const requests: string[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      requests.push(JSON.stringify(request.messages))
      if (calls === 1) return { content: '', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }] }
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom(pending), () => {
    pending.push(queued('q1', 'also check the tests'), queued('q2', '/model'), queued('q3', 'and the docs'))
  }).run({ text: 'fix the bug' })

  assert.equal(calls, 2)
  assert.deepEqual(userTexts(records), ['fix the bug', 'also check the tests'])
  const steered = records.find((record) => record.type === 'message' && record.content === 'also check the tests')
  assert.equal(steered?.type === 'message' && steered.sourceQueuedMessageId, 'q1')
  // After the tool result, within the same turn.
  assert.ok(records.findIndex((record) => record.type === 'tool_result') < records.indexOf(steered!))
  assert.equal(steered?.type === 'message' && steered.turnId, records[0]?.type === 'message' ? records[0].turnId : undefined)
  assert.ok(requests[1]?.includes('also check the tests'))
  assert.ok(!requests[0]?.includes('also check the tests'))
  // The slash command waits for the turn to end, and holds everything behind it.
  assert.deepEqual(pending.map((message) => message.id), ['q2', 'q3'])
})

test('the queued message a turn started from is not steered into it again', async () => {
  const records: SessionRecord[] = []
  const pending = [queued('head', 'fix the bug'), queued('next', 'use the new API')]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom(pending), () => {})
    .run({ text: 'fix the bug' }, undefined, undefined, { sourceQueuedMessageId: 'head' })

  assert.deepEqual(userTexts(records), ['fix the bug', 'use the new API'])
  assert.deepEqual(pending.map((message) => message.id), ['head'])
})
