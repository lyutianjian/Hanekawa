import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import {
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  buildMemoryPrompt,
  readMemoryIndex,
} from '../src/services/memory/memoryPrompt.js'

async function memoryDir(t: test.TestContext, index?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (index !== undefined) await writeFile(path.join(dir, 'MEMORY.md'), index, 'utf8')
  return dir
}

test('a missing or empty index gives an empty section body', async (t) => {
  assert.equal(readMemoryIndex(await memoryDir(t)), '')
  const empty = await memoryDir(t, '\n')
  assert.equal(readMemoryIndex(empty), '')
  assert.match(buildMemoryPrompt(empty), /MEMORY\.md is empty\.$/)
  assert.ok(buildMemoryPrompt(empty).includes(empty))
})

test('an index within the caps is loaded whole', async (t) => {
  const index = '- [A](a.md) — one\n- [B](b.md) — two'
  assert.equal(readMemoryIndex(await memoryDir(t, index)), index)
})

test('too many lines are cut on a line boundary with a notice', async (t) => {
  const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 5 }, (_, i) => `- [n${i}](n${i}.md) — hook`)
  const out = readMemoryIndex(await memoryDir(t, lines.join('\n')))
  assert.ok(out.startsWith(lines.slice(0, MEMORY_INDEX_MAX_LINES).join('\n') + '\n'))
  assert.ok(!out.includes(`n${MEMORY_INDEX_MAX_LINES}.md`))
  assert.match(out, /only the first 200 lines were loaded/)
})

test('the byte cap counts UTF-8 bytes, so multi-byte lines hit it before the line cap', async (t) => {
  const line = '- [记忆](m.md) — ' + '中'.repeat(55)
  const lines = Array.from({ length: 150 }, () => line)
  assert.ok(lines.join('\n').length < MEMORY_INDEX_MAX_BYTES)
  const out = readMemoryIndex(await memoryDir(t, lines.join('\n')))
  const body = out.split('\n\n> ')[0]!
  assert.ok(Buffer.byteLength(body, 'utf8') <= MEMORY_INDEX_MAX_BYTES)
  assert.ok(body.split('\n').every((l) => l === line))
  assert.match(out, /Shorten the entries/)
})

test('the memory section reaches the system prompt only when handed to the builder', async () => {
  const builder = new ContextBuilder(undefined, { contextWindow: 8000, summaryOutputTokens: 0 })
  const input = { records: [], tools: [] }
  const withMemory = await builder.build({ ...input, memoryPrompt: '# Auto memory\nbody' })
  const without = await builder.build(input)
  assert.ok(withMemory.system?.includes('# Auto memory'))
  assert.ok(!without.system?.includes('# Auto memory'))
})
