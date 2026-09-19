import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareRecordsForRequestWithDiagnostics } from '../src/harness/requestPrep.js'
import { ToolResultTrimState } from '../src/harness/toolResultTrimState.js'
import type { SessionRecord } from '../src/harness/types.js'

const CONTEXT = { contextWindow: 200_000, summaryOutputTokens: 0 }

function toolPair(id: string, content: string): SessionRecord[] {
  return [
    {
      type: 'tool_use',
      id: `${id}-call`,
      tool: 'Read',
      input: { id },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: `${id}-result`,
      toolUseId: `${id}-call`,
      tool: 'Read',
      ok: true,
      content,
      createdAt: '2026-05-10T00:00:00.000Z',
    },
  ]
}

function prepare(records: SessionRecord[], trimState: ToolResultTrimState, spillDir?: string): SessionRecord[] {
  return prepareRecordsForRequestWithDiagnostics(records, CONTEXT, new Date(), {
    trimState,
    ...(spillDir ? { spillDir } : {}),
  }).records
}

test('the shared prefix stays byte-identical as tool results accumulate', () => {
  const trimState = new ToolResultTrimState()
  const records: SessionRecord[] = []
  let previous: SessionRecord[] = []

  for (let index = 0; index < 30; index++) {
    records.push(...toolPair(`call-${index}`, 'large output '.repeat(2_000)))
    const prepared = prepare(records, trimState)
    assert.deepEqual(
      prepared.slice(0, previous.length),
      previous,
      `request ${index} rewrote history the model had already been sent`,
    )
    previous = prepared
  }
})

test('a replacement, once chosen, is replayed unchanged', () => {
  const trimState = new ToolResultTrimState()
  const records: SessionRecord[] = [...toolPair('huge', 'x'.repeat(200_000))]

  const first = prepare(records, trimState)
  const replacement = first.find((record) => record.type === 'tool_result')
  assert.equal(replacement?.type, 'tool_result')

  for (let index = 0; index < 10; index++) {
    records.push(...toolPair(`later-${index}`, 'small output'))
    const result = prepare(records, trimState).find(
      (record) => record.type === 'tool_result' && record.id === 'huge-result',
    )
    assert.equal(result?.type, 'tool_result')
    assert.equal(result.content, replacement.content)
  }
})

test('a ledger rebuilt from the session log reproduces the same request', () => {
  const trimState = new ToolResultTrimState()
  const records: SessionRecord[] = [...toolPair('huge', 'x'.repeat(200_000))]
  const original = prepare(records, trimState)

  // What the loop would have appended to the JSONL, replayed on restart.
  const log = [...records, ...trimState.takePendingRecords()]
  const resumed = prepare(log, ToolResultTrimState.fromRecords(log))

  assert.deepEqual(resumed, original)
})

test('a result the log shows as already sent is never trimmed later', () => {
  const log: SessionRecord[] = [...toolPair('huge', 'x'.repeat(200_000))]
  const prepared = prepare(log, ToolResultTrimState.fromRecords(log))

  const result = prepared.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.equal(result.content.length, 200_000)
})

test('an oversized result is spilled to disk and the replacement names the file', () => {
  const spillDir = path.join(mkdtempSync(path.join(tmpdir(), 'trim-spill-')), 'tool-results')
  const content = `head of the output\n${'x'.repeat(200_000)}`
  const records: SessionRecord[] = [...toolPair('huge', content)]

  const prepared = prepare(records, new ToolResultTrimState(), spillDir)
  const result = prepared.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')

  const spillPath = result.content.match(/saved to (\S+) —/)?.[1]
  assert.ok(spillPath, `replacement must name the spill file: ${result.content.slice(0, 200)}`)
  assert.equal(readFileSync(spillPath, 'utf8'), content)
  assert.match(result.content, /head of the output/)
})

test('an unwritable spill directory degrades to preview only', () => {
  const records: SessionRecord[] = [...toolPair('huge', 'x'.repeat(200_000))]

  // A path under a regular file cannot be created.
  const blocked = path.join(import.meta.filename, 'nope')
  const prepared = prepare(records, new ToolResultTrimState(), blocked)

  const result = prepared.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.match(result.content, /could not be saved/)
})
