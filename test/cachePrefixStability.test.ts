import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod/v3'
import { buildAnthropicPayload } from '../src/config/providers.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { resetCacheTTLEvaluation } from '../src/harness/cacheControl.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'

const tool: Tool = {
  name: 'Read',
  description: 'Read a file from disk',
  inputSchema: z.object({ filePath: z.string() }).strict(),
  riskLevel: 'safe',
  execute: async () => ({ ok: true, content: '' }),
}

const at = '2026-05-10T00:00:00.000Z'

/** A turn of `toolTurns` assistant/tool_use/tool_result triples after one user message. */
function records(toolTurns: number): SessionRecord[] {
  const list: SessionRecord[] = [
    { type: 'message', id: 'u1', role: 'user', content: 'read the files', createdAt: at },
  ]
  for (let i = 0; i < toolTurns; i++) {
    list.push(
      { type: 'message', id: `a${i}`, role: 'assistant', content: `reading file ${i}`, createdAt: at },
      { type: 'tool_use', id: `call-${i}`, tool: 'Read', input: { filePath: `f${i}.ts` }, riskLevel: 'safe', createdAt: at },
      { type: 'tool_result', id: `res-${i}`, toolUseId: `call-${i}`, tool: 'Read', ok: true, content: `contents of f${i}.ts`, createdAt: at },
    )
  }
  return list
}

/** Hash a message with `cache_control` removed — the marker itself is not a content difference. */
function hashMessage(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (!block || typeof block !== 'object') return block
        const { cache_control: _marker, ...rest } = block as Record<string, unknown>
        return rest
      })
    : message.content
  return createHash('sha256').update(JSON.stringify({ role: message.role, content })).digest('hex').slice(0, 12)
}

function breakpointIndex(messages: Array<Record<string, unknown>>): number {
  return messages.findIndex((message) =>
    Array.isArray(message.content)
      && message.content.some((block) => Boolean((block as Record<string, unknown>)?.cache_control)),
  )
}

async function payloadMessages(toolTurns: number): Promise<Array<Record<string, unknown>>> {
  const builder = new ContextBuilder(undefined, { contextWindow: 200_000, summaryOutputTokens: 0 })
  const built = await builder.build({
    records: records(toolTurns),
    tools: [tool],
    system: 'system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })
  const payload = buildAnthropicPayload({
    cacheSource: 'agent:test',
    model: 'claude-sonnet-test',
    messages: [],
    contextItems: built.contextItems,
    systemBlocks: built.systemBlocks,
    tools: [tool],
    cacheRuntime: { env: { MYAGENT_PROMPT_CACHE_1H: '0' } },
  }) as unknown as { messages: Array<Record<string, unknown>> }
  return payload.messages
}

test('cache breakpoint stays inside the prefix two consecutive turns share', async () => {
  resetCacheTTLEvaluation()
  const turnN = await payloadMessages(2)
  const turnNext = await payloadMessages(3)

  let commonPrefix = 0
  while (
    commonPrefix < turnN.length
    && commonPrefix < turnNext.length
    && hashMessage(turnN[commonPrefix]) === hashMessage(turnNext[commonPrefix])
  ) commonPrefix++

  const index = breakpointIndex(turnN)
  assert.ok(index >= 0, 'expected a message-level cache breakpoint')
  assert.ok(
    index < commonPrefix,
    `breakpoint at ${index} must fall inside the common prefix of ${commonPrefix} messages`,
  )
})

test('the built payload carries no transient marker field', async () => {
  resetCacheTTLEvaluation()
  const messages = await payloadMessages(2)
  const keys = new Set(messages.flatMap((message) => Object.keys(message)))
  assert.deepEqual([...keys].sort(), ['content', 'role'])
})
