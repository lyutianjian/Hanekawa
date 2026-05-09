import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'

test('tool runner executes safe tool without prompting', async () => {
  let prompted = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: {},
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
    name: 'deleteFile',
    description: 'delete',
    inputSchema: {},
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'deleted' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => false), {
    onRecord: async () => {},
  })
  const result = await runner.run({ id: 'call1', name: 'deleteFile', input: { filePath: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.ok, false)
  assert.match(result.content, /denied/)
})
