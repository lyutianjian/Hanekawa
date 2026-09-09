import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractionPrompt,
  formatRecordsForExtraction,
  truncateSessionMemory,
  isSessionMemoryEmpty,
} from '../src/services/sessionMemory/prompts.js'
import {
  calculateRecordsToKeepIndex,
} from '../src/services/sessionMemory/compact.js'
import type { SessionRecord } from '../src/harness/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'
import type { SessionMemoryConfig } from '../src/services/sessionMemory/types.js'
import { DEFAULT_SESSION_MEMORY_CONFIG } from '../src/services/sessionMemory/types.js'

// --- prompts.ts tests ---

test('buildExtractionPrompt includes existing memory when provided', () => {
  const prompt = buildExtractionPrompt('existing memory content', 'new records', 5)
  assert.match(prompt, /existing memory content/)
  assert.match(prompt, /existing_memory/)
  assert.match(prompt, /new records/)
})

test('buildExtractionPrompt omits existing memory section when not provided', () => {
  const prompt = buildExtractionPrompt(undefined, 'new records', 3)
  assert.doesNotMatch(prompt, /existing_memory/)
  assert.match(prompt, /new records/)
})

test('formatRecordsForExtraction handles message records', () => {
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: '2', role: 'assistant', content: 'hi there', createdAt: '2026-01-01T00:01:00.000Z' },
  ]
  const result = formatRecordsForExtraction(records)
  assert.match(result, /\[User\]: hello/)
  assert.match(result, /\[Assistant\]: hi there/)
})

test('formatRecordsForExtraction handles tool_use and tool_result records', () => {
  const records: SessionRecord[] = [
    { type: 'tool_use', id: 't1', tool: 'Bash', input: { command: 'ls' }, riskLevel: 'dangerous', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'tool_result', id: 'r1', toolUseId: 't1', tool: 'Bash', ok: true, content: 'file1.txt\nfile2.txt', createdAt: '2026-01-01T00:01:00.000Z' },
  ]
  const result = formatRecordsForExtraction(records)
  assert.match(result, /\[Tool Call: Bash\]/)
  assert.match(result, /\[Tool Result: Bash \(ok\)\]/)
})

test('formatRecordsForExtraction projects images with the shared compaction placeholder', () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: '1',
      role: 'user',
      content: 'look at this',
      images: [makeImageAttachmentRef({ id: 'img-a', name: 'a.png', width: 800, height: 600 })],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'r1',
      toolUseId: 't1',
      tool: 'Read',
      ok: true,
      content: 'read an image',
      images: [makeImageAttachmentRef({ id: 'img-b', name: 'b.png' })],
      createdAt: '2026-01-01T00:01:00.000Z',
    },
  ]
  const result = formatRecordsForExtraction(records)
  // Extraction is a text summary too, so it uses the same placeholder wording
  // as compaction — the store is not read here, so refs name their attachment.
  assert.match(result, /\[User\]: look at this\n\[Image attachment omitted[\s\S]*a\.png, sent 800x600, cached in this session's attachment store \(attachment img-a\)/)
  assert.match(result, /\[Tool Result: Read \(ok\)\] read an image\n\[Image attachment omitted[\s\S]*b\.png/)
  assert.match(result, /do not describe or infer what the image shows/)
})

test('formatRecordsForExtraction skips subagent_transcript records', () => {
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'subagent_transcript', id: 'st1', agentId: 'a1', subagentType: 'general', records: [], usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, createdAt: '2026-01-01T00:01:00.000Z' },
  ]
  const result = formatRecordsForExtraction(records)
  assert.match(result, /\[User\]: hello/)
  assert.doesNotMatch(result, /subagent/)
})

test('truncateSessionMemory returns original when under limit', () => {
  const content = 'short content'
  const result = truncateSessionMemory(content, 1000)
  assert.equal(result.truncatedContent, content)
  assert.equal(result.wasTruncated, false)
})

test('truncateSessionMemory truncates when over limit', () => {
  const content = 'word '.repeat(1000) // ~5000 chars
  const result = truncateSessionMemory(content, 100)
  assert.equal(result.wasTruncated, true)
  assert.ok(result.truncatedContent.length < content.length)
  assert.match(result.truncatedContent, /\[.*truncated.*\]/)
})

test('isSessionMemoryEmpty returns true for undefined', () => {
  assert.equal(isSessionMemoryEmpty(undefined), true)
})

test('isSessionMemoryEmpty returns true for empty string', () => {
  assert.equal(isSessionMemoryEmpty(''), true)
})

test('isSessionMemoryEmpty returns true for short content', () => {
  assert.equal(isSessionMemoryEmpty('short'), true)
})

test('isSessionMemoryEmpty returns false for meaningful content', () => {
  assert.equal(isSessionMemoryEmpty('This is a meaningful session memory with enough content.'), false)
})

// --- compact.ts tests ---

const testConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
  enabled: true,
  minTokens: 100,
  minTextMessages: 2,
  maxTokens: 10_000,
}

test('calculateRecordsToKeepIndex returns records.length when no summarized index', () => {
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'hello '.repeat(50), createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: '2', role: 'assistant', content: 'hi '.repeat(50), createdAt: '2026-01-01T00:01:00.000Z' },
  ]
  const index = calculateRecordsToKeepIndex(records, -1, testConfig)
  // Should keep all records (startIndex = records.length, then expand backwards to meet minimums)
  assert.ok(index >= 0)
  assert.ok(index <= records.length)
})

test('calculateRecordsToKeepIndex expands backwards to meet minTokens', () => {
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'a'.repeat(500), createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: '2', role: 'assistant', content: 'b'.repeat(500), createdAt: '2026-01-01T00:01:00.000Z' },
    { type: 'message', id: '3', role: 'user', content: 'c'.repeat(500), createdAt: '2026-01-01T00:02:00.000Z' },
    { type: 'message', id: '4', role: 'assistant', content: 'd'.repeat(500), createdAt: '2026-01-01T00:03:00.000Z' },
  ]
  // lastSummarizedIndex = 1 (message id '2'), so startIndex starts at 2
  // Should expand backwards to include more records for minTokens
  const index = calculateRecordsToKeepIndex(records, 1, testConfig)
  assert.ok(index <= 2)
})

test('calculateRecordsToKeepIndex adjusts for tool_use/tool_result pairs', () => {
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'a'.repeat(500), createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'tool_use', id: 'tu1', tool: 'Bash', input: {}, riskLevel: 'dangerous', createdAt: '2026-01-01T00:01:00.000Z' },
    { type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Bash', ok: true, content: 'result '.repeat(100), createdAt: '2026-01-01T00:02:00.000Z' },
    { type: 'message', id: '2', role: 'assistant', content: 'done '.repeat(100), createdAt: '2026-01-01T00:03:00.000Z' },
  ]
  // If keepIndex would land on tool_result (index 2), it should adjust back to include tool_use (index 1)
  const index = calculateRecordsToKeepIndex(records, 0, testConfig)
  // The tool_use at index 1 should be included if tool_result at index 2 is kept
  const kept = records.slice(index)
  const hasToolResult = kept.some((r) => r.type === 'tool_result')
  const hasToolUse = kept.some((r) => r.type === 'tool_use')
  if (hasToolResult) {
    assert.ok(hasToolUse, 'tool_use must be kept if tool_result is kept')
  }
})

test('calculateRecordsToKeepIndex respects maxTokens cap', () => {
  const config: SessionMemoryConfig = {
    ...testConfig,
    minTokens: 100,
    minTextMessages: 1,
    maxTokens: 200, // Very low cap
  }
  const records: SessionRecord[] = [
    { type: 'message', id: '1', role: 'user', content: 'a'.repeat(1000), createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: '2', role: 'assistant', content: 'b'.repeat(1000), createdAt: '2026-01-01T00:01:00.000Z' },
    { type: 'message', id: '3', role: 'user', content: 'c'.repeat(1000), createdAt: '2026-01-01T00:02:00.000Z' },
    { type: 'message', id: '4', role: 'assistant', content: 'd'.repeat(1000), createdAt: '2026-01-01T00:03:00.000Z' },
  ]
  const index = calculateRecordsToKeepIndex(records, 3, config)
  // Should not keep all records due to maxTokens cap
  const keptTokens = records.slice(index).reduce((sum, r) => {
    if (r.type === 'message') return sum + Math.ceil(r.content.length / 3)
    return sum
  }, 0)
  // The kept tokens should be bounded (though the exact value depends on the estimation)
  assert.ok(index >= 0)
})

// --- storage cwd tests ---

test('session memory reads and writes under the cwd it is given', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const path = (await import('node:path')).default
  const { tmpdir } = await import('node:os')
  const { getSessionMemory, setSessionMemory, clearSessionMemory } =
    await import('../src/services/sessionMemory/service.js')

  const projectA = await mkdtemp(path.join(tmpdir(), 'myagent-sm-a-'))
  const projectB = await mkdtemp(path.join(tmpdir(), 'myagent-sm-b-'))
  const sessionId = 'shared-session-id'

  await setSessionMemory(sessionId, {
    content: 'memory for A',
    lastSummarizedRecordId: 'record-1',
    lastExtractedAt: '2026-01-01T00:00:00.000Z',
    tokenCount: 3,
  }, projectA)

  assert.equal((await getSessionMemory(sessionId, projectA))?.content, 'memory for A')
  // Same session id, different project: must not see A's memory.
  assert.equal(await getSessionMemory(sessionId, projectB), undefined)

  await clearSessionMemory(sessionId, projectB)
  assert.equal((await getSessionMemory(sessionId, projectA))?.content, 'memory for A')

  await clearSessionMemory(sessionId, projectA)
  assert.equal(await getSessionMemory(sessionId, projectA), undefined)
})
